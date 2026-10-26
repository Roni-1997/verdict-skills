#!/usr/bin/env python3
"""Explicit administrator setup for a new, isolated staging database; never run by a function.

Reads the approved provider's credential file and writes runtime credentials to an
exclusive mode-0600 file. Re-running with that file preserves role passwords,
wrapping keys and the deployment's original database identities.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-runner"))
import psycopg
import certifi
from psycopg import sql
from verdict_broker.postgres_store import POSTGRES_STORE_DDL
from verdict_broker.private_vault import ENROLLMENTS_DDL, SIGNER_REQUESTS_DDL


def read_private(path):
    path = Path(path)
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise ValueError("Credential files must be private regular files")
    return path.read_text()


def connection_uri(uri, *, role=None, password=None):
    parsed = urlsplit(uri)
    if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname or "-pooler" in parsed.hostname:
        raise ValueError("An explicit direct PostgreSQL TLS endpoint is required")
    options = dict(parse_qsl(parsed.query))
    options.pop("sslrootcert", None)
    options.update(sslmode="verify-full", connect_timeout="10")
    authority = parsed.netloc
    if role is not None:
        authority = f"{role}:{password}@{parsed.hostname}:{parsed.port or 5432}"
    return urlunsplit(("postgresql", authority, parsed.path, urlencode(options), ""))


def runtime_keys(admin_dsn, identities):
    suffix = identities["deploymentId"].replace("-", "")[:12]
    public_role, private_role = "verdict_mcp_" + suffix, "verdict_signer_" + suffix
    public_password, private_password = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    return {**identities, "version": 1, "publicRole": public_role, "privateRole": private_role,
            "publicPassword": public_password, "privatePassword": private_password,
            "publicDatabaseUrl": connection_uri(admin_dsn, role=public_role, password=public_password),
            "privateDatabaseUrl": connection_uri(admin_dsn, role=private_role, password=private_password),
            "serviceKey": secrets.token_urlsafe(32), "wrappingKey": secrets.token_urlsafe(32)}


def check_role(db, role):
    row = db.execute("SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin,rolinherit FROM pg_roles WHERE rolname=%s", (role,)).fetchone()
    if row is None or any(row[1:6]) or row[6:] != (True, False):
        raise ValueError("Runtime role login or privilege flags differ")
    if db.execute("SELECT 1 FROM pg_auth_members WHERE member=%s LIMIT 1", (row[0],)).fetchone():
        raise ValueError("Runtime role memberships could permit SET ROLE")
    if db.execute("SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=%s AND deptype='o' LIMIT 1", (row[0],)).fetchone():
        raise ValueError("Runtime role must not own database objects")


def marker(db, table, deployment, database, *, jobs=False, fresh=False):
    columns = "database_id::text,version,intent_version" if jobs else "database_id::text,version"
    row = db.execute(sql.SQL("SELECT " + columns + " FROM {} WHERE deployment_id=%s").format(sql.Identifier(*table.split("."))), (deployment,)).fetchone()
    expected = (database, 1, 1) if jobs else (database, 1)
    if row is not None and row != expected:
        raise ValueError("Existing deployment identity differs; never reset authority")
    if row is None:
        if not fresh:
            raise ValueError("Original deployment marker is missing; never initialize replacement authority")
        placeholders = "%s,%s,1,1" if jobs else "%s,%s,1"
        db.execute(sql.SQL("INSERT INTO {} VALUES(" + placeholders + ")").format(sql.Identifier(*table.split("."))), (deployment, database))


def provision(admin_dsn, credentials, public_ddl):
    deployment = credentials["deploymentId"]
    with psycopg.connect(admin_dsn, sslrootcert=certifi.where(), autocommit=True) as db:
        with db.transaction():
            db.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("verdict-staging-bootstrap:" + deployment,))
            expected = {
                "verdict_mcp": {"authority_metadata", "authority_records", "authority_enrollments", "jobs_metadata", "hosted_jobs", "lighter_intents"},
                "verdict_signer": {"runtime_metadata", "private_namespaces", "private_records", "private_events", "vault_state", "private_enrollments", "service_requests"},
            }
            existing = {schema: {row[0] for row in db.execute("SELECT tablename FROM pg_tables WHERE schemaname=%s", (schema,))} for schema in expected}
            fresh = not any(existing.values())
            if not fresh and existing != expected:
                raise ValueError("Partial original schema requires recovery, never recreation")
            db.execute(public_ddl)
            db.execute(POSTGRES_STORE_DDL + ENROLLMENTS_DDL + SIGNER_REQUESTS_DDL)
            marker(db, "verdict_mcp.authority_metadata", deployment, credentials["publicDatabaseId"], fresh=fresh)
            marker(db, "verdict_mcp.jobs_metadata", deployment, credentials["publicDatabaseId"], jobs=True, fresh=fresh)
            marker(db, "verdict_signer.runtime_metadata", deployment, credentials["privateDatabaseId"], fresh=fresh)
            witness = db.execute("SELECT enrollment_count FROM verdict_signer.vault_state WHERE deployment_id=%s", (deployment,)).fetchone()
            if witness is None:
                if not fresh:
                    raise ValueError("Original enrollment witness is missing")
                count = db.execute("SELECT count(*) FROM verdict_signer.private_enrollments WHERE deployment_id=%s", (deployment,)).fetchone()[0]
                if count != 0:
                    raise ValueError("Existing enrollments lack their original witness")
                db.execute("INSERT INTO verdict_signer.vault_state VALUES(%s,0)", (deployment,))
            database_name = db.info.dbname
            db.execute(sql.SQL("REVOKE CREATE,TEMPORARY ON DATABASE {} FROM PUBLIC").format(sql.Identifier(database_name)))
            db.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
            for schema in ("verdict_mcp", "verdict_signer"):
                db.execute(sql.SQL("REVOKE ALL ON SCHEMA {} FROM PUBLIC").format(sql.Identifier(schema)))
                db.execute(sql.SQL("REVOKE ALL ON ALL TABLES IN SCHEMA {} FROM PUBLIC").format(sql.Identifier(schema)))
            for kind in ("public", "private"):
                role, password = credentials[kind + "Role"], credentials[kind + "Password"]
                exists = db.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role,)).fetchone()
                if exists is None:
                    db.execute(sql.SQL("CREATE ROLE {} LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}").format(sql.Identifier(role), sql.Literal(password)))
                else:
                    check_role(db, role)
                db.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(database_name), sql.Identifier(role)))
                for schema in ("public", "verdict_mcp", "verdict_signer"):
                    db.execute(sql.SQL("REVOKE ALL ON SCHEMA {} FROM {}").format(sql.Identifier(schema), sql.Identifier(role)))
                    db.execute(sql.SQL("REVOKE ALL ON ALL TABLES IN SCHEMA {} FROM {}").format(sql.Identifier(schema), sql.Identifier(role)))
            pub, private = sql.Identifier(credentials["publicRole"]), sql.Identifier(credentials["privateRole"])
            db.execute(sql.SQL("GRANT USAGE ON SCHEMA verdict_mcp TO {}").format(pub))
            db.execute(sql.SQL("GRANT SELECT ON verdict_mcp.authority_metadata,verdict_mcp.jobs_metadata TO {}").format(pub))
            db.execute(sql.SQL("GRANT SELECT,INSERT,UPDATE ON verdict_mcp.authority_enrollments,verdict_mcp.hosted_jobs,verdict_mcp.lighter_intents TO {}").format(pub))
            db.execute(sql.SQL("GRANT SELECT,INSERT,UPDATE,DELETE ON verdict_mcp.authority_records TO {}").format(pub))
            db.execute(sql.SQL("GRANT USAGE ON ALL SEQUENCES IN SCHEMA verdict_mcp TO {}").format(pub))
            db.execute(sql.SQL("GRANT USAGE ON SCHEMA verdict_signer TO {}").format(private))
            db.execute(sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA verdict_signer TO {}").format(private))
            db.execute(sql.SQL("GRANT INSERT ON verdict_signer.private_records,verdict_signer.private_events,verdict_signer.private_namespaces,verdict_signer.private_enrollments,verdict_signer.service_requests TO {}").format(private))
            db.execute(sql.SQL("GRANT UPDATE(record_count,event_count) ON verdict_signer.private_namespaces TO {}").format(private))
            db.execute(sql.SQL("GRANT UPDATE(enrollment_count) ON verdict_signer.vault_state TO {}").format(private))
            db.execute(sql.SQL("GRANT UPDATE(version,account,api_key_index,nonce,ciphertext) ON verdict_signer.private_enrollments TO {}").format(private))
            db.execute(sql.SQL("GRANT UPDATE(state,result) ON verdict_signer.service_requests TO {}").format(private))


def prove_roles(credentials):
    checks = []
    for kind in ("public", "private"):
        with psycopg.connect(credentials[kind + "DatabaseUrl"], sslrootcert=certifi.where(), autocommit=True) as db:
            check_role(db, credentials[kind + "Role"])
            forbidden = ["CREATE TABLE public.verdict_forbidden(id integer)", "CREATE SCHEMA verdict_forbidden"]
            if kind == "public":
                tables = [row[0] for row in db.execute("SELECT tablename FROM pg_tables WHERE schemaname='verdict_signer'").fetchall()]
                forbidden += ["SELECT * FROM verdict_signer." + name + " LIMIT 0" for name in tables]
                forbidden += ["UPDATE verdict_mcp.jobs_metadata SET version=1 WHERE false", "DELETE FROM verdict_mcp.hosted_jobs WHERE false"]
            else:
                forbidden += ["SELECT * FROM verdict_mcp.authority_records LIMIT 0", "DELETE FROM verdict_signer.private_events WHERE false", "UPDATE verdict_signer.runtime_metadata SET version=1 WHERE false", "UPDATE verdict_signer.private_records SET data='{}' WHERE false"]
            for statement in forbidden:
                try:
                    with db.transaction():
                        db.execute(statement)
                        raise ValueError("A forbidden runtime operation was allowed")
                except psycopg.errors.InsufficientPrivilege:
                    checks.append(True)
    return len(checks)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--admin-env-file", required=True)
    parser.add_argument("--identities", required=True)
    parser.add_argument("--public-ddl-file", required=True)
    parser.add_argument("--credentials-file", required=True)
    parser.add_argument("--apply-staging", action="store_true", required=True)
    args = parser.parse_args()
    env = {}
    for line in read_private(args.admin_env_file).splitlines():
        name, separator, value = line.partition("=")
        if separator and name == "VERDICT_BOOTSTRAP_DATABASE_URL_UNPOOLED":
            env[name] = json.loads(value) if value.startswith('"') else value.strip("'")
    admin_dsn = connection_uri(env["VERDICT_BOOTSTRAP_DATABASE_URL_UNPOOLED"])
    identities = json.loads(read_private(args.identities))
    if set(identities) != {"deploymentId", "publicDatabaseId", "privateDatabaseId"}:
        raise ValueError("Expected fixed staging deployment identities")
    for value in identities.values():
        if str(uuid.UUID(value)) != value:
            raise ValueError("Expected canonical deployment identities")
    output = Path(args.credentials_file)
    if output.exists():
        credentials = json.loads(read_private(output))
        if any(credentials[key] != value for key, value in identities.items()):
            raise ValueError("Original runtime credentials differ")
        for key in ("publicDatabaseUrl", "privateDatabaseUrl"):
            credentials[key] = connection_uri(credentials[key])
    else:
        credentials = runtime_keys(admin_dsn, identities)
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(credentials, stream)
            stream.flush(); os.fsync(stream.fileno())
        directory = os.open(output.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    provision(admin_dsn, credentials, Path(args.public_ddl_file).read_text())
    denied = prove_roles(credentials)
    print(json.dumps({"provisioned": True, "deploymentId": identities["deploymentId"], "runtimeRoleDenials": denied, "adminCredentialDeployed": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Driver exceptions can contain credentials or SQL values. Keep them off CI and deploy logs.
        print(json.dumps({"provisioned": False, "errorType": type(error).__name__, "message": "Staging setup failed; inspect privately without exposing database credentials."}))
        sys.exit(1)
