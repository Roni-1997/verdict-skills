"""Durable broker state on a direct PostgreSQL session. Runtime never creates schema."""
from __future__ import annotations

import contextlib
import hashlib
import json
import re
import time
import uuid

import certifi
import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb

from .core import BrokerError, account_key, json_load, unresolved_accounts


POSTGRES_STORE_DDL = """
CREATE SCHEMA IF NOT EXISTS verdict_signer;
CREATE TABLE IF NOT EXISTS verdict_signer.runtime_metadata (
 deployment_id UUID PRIMARY KEY, database_id UUID NOT NULL, version INTEGER NOT NULL CHECK(version=1));
CREATE TABLE IF NOT EXISTS verdict_signer.private_namespaces (
 deployment_id UUID NOT NULL REFERENCES verdict_signer.runtime_metadata(deployment_id),
 namespace UUID NOT NULL, version INTEGER NOT NULL CHECK(version=1),
 record_count BIGINT NOT NULL DEFAULT 0 CHECK(record_count>=0),
 event_count BIGINT NOT NULL DEFAULT 0 CHECK(event_count>=0),
 PRIMARY KEY(deployment_id,namespace));
CREATE TABLE IF NOT EXISTS verdict_signer.private_records (
 deployment_id UUID NOT NULL, namespace UUID NOT NULL, name TEXT NOT NULL, data JSONB NOT NULL,
 PRIMARY KEY(deployment_id,namespace,name),
 FOREIGN KEY(deployment_id,namespace) REFERENCES verdict_signer.private_namespaces(deployment_id,namespace));
CREATE TABLE IF NOT EXISTS verdict_signer.private_events (
 deployment_id UUID NOT NULL, namespace UUID NOT NULL, digest TEXT NOT NULL,
 sequence BIGINT NOT NULL CHECK(sequence>=0), body JSONB NOT NULL,
 PRIMARY KEY(deployment_id,namespace,digest,sequence),
 FOREIGN KEY(deployment_id,namespace) REFERENCES verdict_signer.private_namespaces(deployment_id,namespace));
"""


def connection_options(dsn):
    """Use a portable CA bundle and hostname verification for hosted TCP sessions."""
    target = conninfo_to_dict(dsn)
    host = target.get("host", "")
    tcp = target.get("hostaddr") or (host and not host.startswith(("/", "@")))
    return {"sslmode": "verify-full", "sslrootcert": certifi.where()} if tcp else {}


def _id(value):
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError
        return value
    except (ValueError, TypeError, AttributeError):
        raise BrokerError("Invalid private storage identity") from None


def _digest(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:authority|[0-9a-f]{64})", value):
        raise BrokerError("Invalid private journal identity")
    return value


def _name(value):
    match = re.fullmatch(r"(?:grant|revoked|scope-proof)-([0-9a-f-]{36})\.json", value) if isinstance(value, str) else None
    if match is None:
        raise BrokerError("Invalid private record identity")
    _id(match.group(1))
    return value


def _encoded(value, limit=1_048_576):
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode()) > limit:
            raise ValueError
        return encoded
    except (ValueError, TypeError):
        raise BrokerError("Invalid or oversized private state") from None


@contextlib.contextmanager
def advisory_lock(connection, key):
    """Session lock spans independently committed records. Transaction pooling is unsafe."""
    identity = int.from_bytes(hashlib.sha256(key.encode()).digest()[:8], "big", signed=True)
    try:
        if not connection.execute("SELECT pg_try_advisory_lock(%s)", (identity,)).fetchone()[0]:
            raise BrokerError("Private execution state is busy")
        try:
            yield
        finally:
            if not connection.closed:
                connection.execute("SELECT pg_advisory_unlock(%s)", (identity,))
    except BrokerError:
        raise
    except Exception:
        raise BrokerError("Private storage session unavailable; reconcile original attempts") from None


class PostgresStore:
    def __init__(self, dsn, *, deployment, namespace, database_id):
        self.deployment, self.namespace, self.database_id = _id(deployment), _id(namespace), _id(database_id)
        self.connection = None
        try:
            self.connection = psycopg.connect(dsn, **connection_options(dsn), autocommit=True, connect_timeout=5)
            self.connection.execute("SET statement_timeout='5000ms'")
            self.connection.execute("SET lock_timeout='3000ms'")
            self._guard()
        except Exception:
            self.close()
            raise BrokerError("Required private storage is missing or unavailable; never recreate budgets") from None

    @classmethod
    def provision(cls, dsn, *, deployment, namespace, database_id):
        deployment, namespace, database_id = _id(deployment), _id(namespace), _id(database_id)
        try:
            with psycopg.connect(dsn, **connection_options(dsn), autocommit=True, connect_timeout=5) as connection:
                row = connection.execute("SELECT database_id::text,version FROM verdict_signer.runtime_metadata WHERE deployment_id=%s", (deployment,)).fetchone()
                if row != (database_id, 1):
                    raise BrokerError("Private storage initialization marker differs")
                connection.execute("INSERT INTO verdict_signer.private_namespaces(deployment_id,namespace,version) VALUES(%s,%s,1) ON CONFLICT DO NOTHING", (deployment, namespace))
            return cls(dsn, deployment=deployment, namespace=namespace, database_id=database_id)
        except BrokerError:
            raise
        except Exception:
            raise BrokerError("Private namespace provisioning unavailable") from None

    @property
    def identity(self):
        return ("postgres", self.deployment, self.database_id, self.namespace)

    def _guard(self):
        if self.connection is None or self.connection.closed:
            raise BrokerError("Private storage session was lost; never reacquire and resume a send")
        try:
            marker = self.connection.execute("SELECT database_id::text,version FROM verdict_signer.runtime_metadata WHERE deployment_id=%s", (self.deployment,)).fetchone()
            row = self.connection.execute("""SELECT version,record_count,event_count,
              (SELECT count(*) FROM verdict_signer.private_records WHERE deployment_id=%s AND namespace=%s),
              (SELECT count(*) FROM verdict_signer.private_events WHERE deployment_id=%s AND namespace=%s)
              FROM verdict_signer.private_namespaces WHERE deployment_id=%s AND namespace=%s""", (self.deployment, self.namespace) * 3).fetchone()
            if marker != (self.database_id, 1) or row is None or row[0] != 1 or row[1:3] != row[3:5]:
                raise BrokerError("Private state initialization or journal witness changed")
        except BrokerError:
            raise
        except Exception:
            raise BrokerError("Private durable state unavailable") from None

    @contextlib.contextmanager
    def authority_locked(self):
        self._guard()
        with advisory_lock(self.connection, f"verdict:authority:{self.deployment}:{self.namespace}"):
            self._guard()
            yield

    @contextlib.contextmanager
    def locked(self, legs):
        self._guard()
        with contextlib.ExitStack() as locks:
            for key in sorted({account_key(leg) for leg in legs}):
                locks.enter_context(advisory_lock(self.connection, f"verdict:account:{self.deployment}:{key}"))
            self._guard()
            yield

    def read_private(self, name, *, missing_ok=False):
        self._guard()
        try:
            row = self.connection.execute("SELECT data FROM verdict_signer.private_records WHERE deployment_id=%s AND namespace=%s AND name=%s", (self.deployment, self.namespace, _name(name))).fetchone()
            if row is None:
                if missing_ok:
                    return None
                raise BrokerError("Required authority state is missing; never recreate budgets")
            return json_load(_encoded(row[0]))
        except BrokerError:
            raise
        except Exception:
            raise BrokerError("Private record unavailable") from None

    def private_names(self, prefix, suffix):
        self._guard()
        try:
            rows = self.connection.execute("SELECT name FROM verdict_signer.private_records WHERE deployment_id=%s AND namespace=%s ORDER BY name", (self.deployment, self.namespace)).fetchall()
            return [name for (name,) in rows if name.startswith(prefix) and name.endswith(suffix)]
        except Exception:
            raise BrokerError("Private record registry unavailable") from None

    def write_once(self, name, value, *, allow_existing=False):
        name, encoded = _name(name), _encoded(value)
        self._guard()
        try:
            with self.connection.transaction():
                self.connection.execute("SELECT namespace FROM verdict_signer.private_namespaces WHERE deployment_id=%s AND namespace=%s FOR UPDATE", (self.deployment, self.namespace))
                row = self.connection.execute("SELECT data FROM verdict_signer.private_records WHERE deployment_id=%s AND namespace=%s AND name=%s", (self.deployment, self.namespace, name)).fetchone()
                if row is not None:
                    if allow_existing and row[0] == json_load(encoded):
                        return
                    raise BrokerError("Immutable authority state already exists or differs")
                self.connection.execute("INSERT INTO verdict_signer.private_records VALUES(%s,%s,%s,%s)", (self.deployment, self.namespace, name, Jsonb(json_load(encoded))))
                self.connection.execute("UPDATE verdict_signer.private_namespaces SET record_count=record_count+1 WHERE deployment_id=%s AND namespace=%s", (self.deployment, self.namespace))
        except BrokerError:
            raise
        except Exception:
            raise BrokerError("Private record commit unavailable; do not retry a send") from None

    def read(self, digest):
        self._guard()
        try:
            rows = self.connection.execute("SELECT sequence,body FROM verdict_signer.private_events WHERE deployment_id=%s AND namespace=%s AND digest=%s ORDER BY sequence", (self.deployment, self.namespace, _digest(digest))).fetchall()
            events = []
            size = 0
            for sequence, value in rows:
                text = _encoded(value); size += len(text.encode())
                event = json_load(text)
                if sequence != len(events) or not isinstance(event, dict) or event.get("sequence") != sequence or event.get("digest") != digest or size > 16_777_216:
                    raise BrokerError("Private journal corrupt or oversized; never resubmit")
                events.append(event)
            return events
        except BrokerError:
            raise
        except Exception:
            raise BrokerError("Private journal unavailable") from None

    def append(self, digest, event):
        digest = _digest(digest)
        if not isinstance(event, dict):
            raise BrokerError("Invalid private journal event")
        self._guard()
        try:
            with self.connection.transaction():
                self.connection.execute("SELECT namespace FROM verdict_signer.private_namespaces WHERE deployment_id=%s AND namespace=%s FOR UPDATE", (self.deployment, self.namespace))
                events = self.read(digest)
                row = {**event, "sequence": len(events), "digest": digest, "at": time.time()}
                _encoded(row)
                self.connection.execute("INSERT INTO verdict_signer.private_events VALUES(%s,%s,%s,%s,%s)", (self.deployment, self.namespace, digest, len(events), Jsonb(row)))
                self.connection.execute("UPDATE verdict_signer.private_namespaces SET event_count=event_count+1 WHERE deployment_id=%s AND namespace=%s", (self.deployment, self.namespace))
        except BrokerError:
            raise
        except Exception:
            raise BrokerError("Private journal commit unavailable; reconcile original attempt") from None

    def proposal_journals(self):
        self._guard()
        try:
            rows = self.connection.execute("SELECT DISTINCT digest FROM verdict_signer.private_events WHERE deployment_id=%s AND namespace=%s AND digest<>'authority' ORDER BY digest", (self.deployment, self.namespace)).fetchall()
            return [(digest, self.read(digest)) for (digest,) in rows]
        except BrokerError:
            raise
        except Exception:
            raise BrokerError("Private journal registry unavailable") from None

    def unresolved_accounts(self, *, exclude_digest=None):
        return unresolved_accounts(self.proposal_journals(), exclude_digest=exclude_digest)

    def close(self):
        if self.connection is not None:
            self.connection.close()
