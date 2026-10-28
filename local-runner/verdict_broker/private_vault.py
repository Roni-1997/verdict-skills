"""Private PostgreSQL enrollment state; migrations run only as a separate administrator.

Runtime uses a direct session-preserving connection. Every provisioning command
holds its subject lock across external work, but each CAS/claim commits before a
venue mutation. The public database role must have no access to this schema.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import uuid

from .core import BrokerError, json_load
from .provisioner import address, integer

ENROLLMENTS_DDL = """
CREATE TABLE IF NOT EXISTS verdict_signer.vault_state (
  deployment_id uuid PRIMARY KEY REFERENCES verdict_signer.runtime_metadata(deployment_id),
  enrollment_count bigint NOT NULL CHECK (enrollment_count BETWEEN 0 AND 1000)
);
CREATE TABLE IF NOT EXISTS verdict_signer.private_enrollments (
  deployment_id uuid NOT NULL REFERENCES verdict_signer.runtime_metadata(deployment_id),
  subject text NOT NULL CHECK (length(subject) BETWEEN 11 AND 266),
  owner text NOT NULL,
  network text NOT NULL CHECK (network = 'testnet'),
  enrollment_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  account bigint CHECK (account BETWEEN 0 AND 9007199254740991),
  api_key_index smallint CHECK (api_key_index BETWEEN 5 AND 254),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 16 AND 1048592),
  PRIMARY KEY (deployment_id, subject),
  UNIQUE (deployment_id, owner, network),
  UNIQUE (deployment_id, enrollment_id),
  UNIQUE (deployment_id, network, account, api_key_index),
  CHECK ((account IS NULL) = (api_key_index IS NULL))
);
"""

SIGNER_REQUESTS_DDL = """
CREATE TABLE IF NOT EXISTS verdict_signer.service_requests (
  deployment_id uuid NOT NULL REFERENCES verdict_signer.runtime_metadata(deployment_id),
  request_id uuid NOT NULL,
  body_hash text NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('claimed','complete')),
  result jsonb,
  PRIMARY KEY (deployment_id, request_id),
  CHECK ((state = 'complete') = (result IS NOT NULL))
);
"""


def canonical_uuid(value):
    if not isinstance(value, str):
        raise BrokerError("Expected canonical deployment identity")
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError
    except ValueError:
        raise BrokerError("Expected canonical deployment identity") from None
    return value


def logical_lock(*parts):
    raw = hashlib.sha256("\0".join(parts).encode()).digest()[:8]
    return int.from_bytes(raw, "big", signed=True)


def subject_value(value):
    if not isinstance(value, str) or not re.fullmatch(r"did:privy:[A-Za-z0-9_-]{1,256}", value):
        raise BrokerError("Invalid private provisioning subject")
    return value


def connection_options(dsn):
    from psycopg.conninfo import conninfo_to_dict
    target = conninfo_to_dict(dsn)
    options = {"autocommit": True, "connect_timeout": 5}
    host = target.get("host", "")
    if target.get("hostaddr") or (host and not host.startswith(("/", "@"))):
        import certifi
        options.update(sslmode="verify-full", sslrootcert=certifi.where())
    return options


class VersionedEnrollment(dict):
    """Private version metadata is not part of the encrypted/public domain record."""
    def __init__(self, record, version):
        super().__init__(record)
        self.version = version


class PostgresVault:
    def __init__(self, dsn, *, deployment, database_id, wrapping_key, connect=None):
        from Crypto.Cipher import AES
        if connect is None:
            import psycopg
            connect = psycopg.connect
        self.deployment, self.database_id = canonical_uuid(deployment), canonical_uuid(database_id)
        if not isinstance(wrapping_key, bytes) or len(wrapping_key) != 32:
            raise BrokerError("Private wrapping credential must be exactly 32 bytes")
        self.key, self.AES = wrapping_key, AES
        self.db = connect(dsn, **connection_options(dsn))
        self._subject = None
        self._closed = False
        try:
            self.db.execute("SET statement_timeout='5000ms'")
            self.db.execute("SET lock_timeout='3000ms'")
            self.check_identity()
        except Exception:
            self.close()
            raise

    def check_identity(self):
        if self._closed or self.db.closed or self.db.broken:
            raise BrokerError("Private enrollment connection lost; no mutation resumed")
        row = self.db.execute("SELECT database_id, version FROM verdict_signer.runtime_metadata WHERE deployment_id=%s",
                              (self.deployment,)).fetchone()
        if row is None or str(row[0]) != self.database_id or row[1] != 1:
            raise BrokerError("Private database identity missing or changed; no state recreated")
        witness = self.db.execute("SELECT enrollment_count,(SELECT count(*) FROM verdict_signer.private_enrollments WHERE deployment_id=%s) FROM verdict_signer.vault_state WHERE deployment_id=%s",
                                  (self.deployment, self.deployment)).fetchone()
        if witness is None or witness[0] != witness[1]:
            raise BrokerError("Private enrollment witness missing or changed; no budget recreated")
        if self._subject is not None:
            key = logical_lock("enrollment", self.deployment, self._subject) & ((1 << 64) - 1)
            held = self.db.execute("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=%s::oid AND objid=%s::oid AND objsubid=1 AND granted)",
                                   (key >> 32, key & 0xffffffff)).fetchone()[0]
            if held is not True:
                raise BrokerError("Private enrollment lock was lost; no mutation resumed")

    @contextlib.contextmanager
    def locked(self, subject):
        subject_value(subject)
        if self._subject is not None:
            raise BrokerError("Nested private enrollment context is forbidden")
        self.check_identity()
        key = logical_lock("enrollment", self.deployment, subject)
        if self.db.execute("SELECT pg_try_advisory_lock(%s)", (key,)).fetchone()[0] is not True:
            raise BrokerError("Private enrollment is busy; inspect the original operation")
        self._subject = subject
        try:
            yield
            self.check_identity()
        finally:
            self._subject = None
            if not self.db.closed and not self.db.broken:
                self.db.execute("SELECT pg_advisory_unlock(%s)", (key,))

    def _metadata(self, record):
        subject = subject_value(record.get("subject"))
        enrollment = canonical_uuid(record.get("id"))
        owner = address(record.get("owner"))
        target = (None, None)
        if "account" in record or "apiKeyIndex" in record:
            target = (integer(record.get("account")), integer(record.get("apiKeyIndex"), 5, 254))
        return subject, owner, enrollment, *target

    def _aad(self, subject, owner, enrollment, account, slot):
        return json.dumps(["verdict-vault/1", self.database_id, self.deployment, subject, owner, enrollment,
                           "testnet", account, slot], separators=(",", ":"), ensure_ascii=True).encode()

    def read(self, subject):
        subject_value(subject)
        self.check_identity()
        row = self.db.execute("SELECT owner,enrollment_id,version,account,api_key_index,nonce,ciphertext FROM verdict_signer.private_enrollments WHERE deployment_id=%s AND subject=%s",
                              (self.deployment, subject)).fetchone()
        if row is None:
            return None
        try:
            owner, enrollment, version, account, slot, nonce, encrypted = row
            cipher = self.AES.new(self.key, self.AES.MODE_GCM, nonce=bytes(nonce))
            cipher.update(self._aad(subject, owner, str(enrollment), account, slot))
            raw = bytes(encrypted)
            value = json_load(cipher.decrypt_and_verify(raw[:-16], raw[-16:]).decode())
            if self._metadata(value) != (subject, owner, str(enrollment), account, slot):
                raise ValueError
            return VersionedEnrollment(value, version)
        except Exception:
            raise BrokerError("Private enrollment ciphertext or identity failed authentication") from None

    def save(self, record, *, expected_version):
        self.check_identity()
        subject, owner, enrollment, account, slot = self._metadata(record)
        if self._subject != subject:
            raise BrokerError("Private enrollment save requires its held subject context")
        if expected_version is not None:
            integer(expected_version, 1)
        raw = json.dumps(record, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()
        if len(raw) > 1_048_576:
            raise BrokerError("Private enrollment exceeds its size limit")
        nonce = os.urandom(12)
        cipher = self.AES.new(self.key, self.AES.MODE_GCM, nonce=nonce)
        cipher.update(self._aad(subject, owner, enrollment, account, slot))
        encrypted, tag = cipher.encrypt_and_digest(raw)
        try:
            with self.db.transaction():
                if expected_version is None:
                    # Capacity is global per deployment; absence of a subject row is not a lock.
                    self.db.execute("SELECT pg_advisory_xact_lock(%s)", (logical_lock("enrollment-capacity", self.deployment),))
                    if self.count() >= 1000:
                        raise BrokerError("Private enrollment capacity reached")
                    row = self.db.execute("INSERT INTO verdict_signer.private_enrollments(deployment_id,subject,owner,network,enrollment_id,version,account,api_key_index,nonce,ciphertext) VALUES(%s,%s,%s,'testnet',%s,1,%s,%s,%s,%s) RETURNING version",
                                          (self.deployment, subject, owner, enrollment, account, slot, nonce, encrypted + tag)).fetchone()
                    changed = self.db.execute("UPDATE verdict_signer.vault_state SET enrollment_count=enrollment_count+1 WHERE deployment_id=%s", (self.deployment,)).rowcount
                    if changed != 1:
                        raise BrokerError("Private enrollment witness unavailable")
                else:
                    row = self.db.execute("UPDATE verdict_signer.private_enrollments SET version=version+1,account=%s,api_key_index=%s,nonce=%s,ciphertext=%s WHERE deployment_id=%s AND subject=%s AND owner=%s AND enrollment_id=%s AND version=%s AND (account IS NULL OR account=%s) AND (api_key_index IS NULL OR api_key_index=%s) RETURNING version",
                                          (account, slot, nonce, encrypted + tag, self.deployment, subject, owner, enrollment, expected_version, account, slot)).fetchone()
                if row is None:
                    raise BrokerError("Private enrollment version or immutable target changed")
            return VersionedEnrollment(record, row[0])
        except BrokerError:
            raise
        except Exception:
            raise BrokerError("Private enrollment save conflicted; original state is retained") from None

    def count(self):
        self.check_identity()
        return self.db.execute("SELECT count(*) FROM verdict_signer.private_enrollments WHERE deployment_id=%s", (self.deployment,)).fetchone()[0]

    def close(self):
        if not self._closed:
            self._closed = True
            self.db.close()


class ServiceRequests:
    """Committed request fences; only the original winner can save its response."""
    def __init__(self, vault):
        self.vault = vault

    def claim(self, request_id, body_hash):
        canonical_uuid(request_id)
        if not re.fullmatch(r"[a-f0-9]{64}", body_hash):
            raise BrokerError("Invalid service request digest")
        self.vault.check_identity()
        row = self.vault.db.execute("INSERT INTO verdict_signer.service_requests(deployment_id,request_id,body_hash,state) VALUES(%s,%s,%s,'claimed') ON CONFLICT DO NOTHING RETURNING body_hash",
                                    (self.vault.deployment, request_id, body_hash)).fetchone()
        if row is not None:
            return {"kind": "claimed"}
        old = self.vault.db.execute("SELECT body_hash,state,result FROM verdict_signer.service_requests WHERE deployment_id=%s AND request_id=%s",
                                    (self.vault.deployment, request_id)).fetchone()
        if old is None or old[0] != body_hash:
            raise BrokerError("Service request identity changed; original operation cannot be replaced")
        return {"kind": old[1], "result": old[2]}

    def complete(self, request_id, body_hash, result):
        self.vault.check_identity()
        from psycopg.types.json import Jsonb
        changed = self.vault.db.execute("UPDATE verdict_signer.service_requests SET state='complete',result=%s WHERE deployment_id=%s AND request_id=%s AND body_hash=%s AND state='claimed'",
                                        (Jsonb(result), self.vault.deployment, request_id, body_hash)).rowcount
        if changed != 1:
            raise BrokerError("Service response fence changed; original operation must be observed")
