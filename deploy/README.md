# Hosted MCP on Vercel

Deploy two separate projects: a public Node22 MCP/OAuth service and an authenticated
Python signer. Both use provisioned PostgreSQL state. The pilot supports Lighter
**testnet** and requires the account owner's registration and scope signatures.
The operator selects `per_order` or `policy` in signer configuration. The agent
cannot change that mode or its spending limits.

## Database setup

Use an isolated staging database and a direct PostgreSQL endpoint for the signer.
Session advisory locks must survive the short transactions that persist send
attempts. A transaction-pool endpoint is unsuitable for the signer. TCP clients
verify the server certificate and hostname; Python uses the pinned Certifi bundle.

Run migrations with a separate administrator credential. Runtime code never
creates missing schemas, metadata or replacement budgets. Public SQL is exported
as `POSTGRES_AUTHORITY_DDL` and `POSTGRES_JOBS_DDL` from the built MCP package.
Private SQL is exported by `postgres_store.py` and `private_vault.py`.

`scripts/provision-staging-postgres.py` is an explicit administrator setup tool for
the approved Vercel/Neon staging resource. Its inputs are private files: the
provider bootstrap environment, fixed deployment/database UUIDs, exported public
DDL, and an exclusive runtime credential output. Run `--help` for arguments. The
tool preserves original credentials, rejects partial existing schemas, creates
separate restricted roles, and proves forbidden SQL operations are denied.
Keep its credential files outside the checkout and deployment bundles.

The public role can access only `verdict_mcp`. The signer role can access only
`verdict_signer`, with immutable grant/journal records and no delete or schema
privileges. Neither runtime owns database objects or has role memberships. Never
deploy the migration credential. Recover the original state after loss; do not
initialize a replacement allowance.

## Build clean artifacts

Install the pinned Node22/pnpm dependencies and build the workspace. Build the
public artifact with:

```sh
pnpm run build:vercel:public /absolute/path/to/public-artifact
```

The script bundles production dependencies, records source hashes, and imports
the actual generated handler in a clean subprocess. CI also runs the PostgreSQL
approval/execution lifecycle against that generated artifact in both modes.

For the private artifact, first create a production CLI installation:

```sh
pnpm --filter @verdict/cli deploy --prod --legacy /absolute/path/to/cli-runtime
node scripts/package-private-vercel.mjs \
  --cli /absolute/path/to/cli-runtime \
  --node-runtime /absolute/path/to/verified-node-runtime \
  --out /absolute/path/to/new-private-artifact
```

The Node runtime directory contains the official Linux x64 archive, extracted
`node-linux-x64`, and `node-runtime.json`. All checksums must match the committed
[runtime manifest](private/node-runtime.json). The private packager verifies the
archive, executable hash and architecture, bundles the CLI, proves canonical
proposal prepare/validate behavior, and copies only explicitly allowed files.
It includes licenses and a file-hash inventory. No account key, database credential,
test fixture or workspace `node_modules` belongs in the artifact.

## Configure projects

The public project receives `VERDICT_ACCOUNT_SERVICE_CONFIG` JSON parsed by
`AccountServiceConfig`. Select PostgreSQL storage, pinned deployment/database UUIDs,
the existing staging Privy app with JWKS verification, the exact HTTPS app origin,
and a fixed `hosted_signer` origin. Its other environment variables are the public
runtime database URL, independent app relay secret, and private service HMAC key.
It must never receive the signer database URL or wrapping key.

The private project's `VERDICT_SIGNER_*` variables select its direct database URL,
deployment/database UUIDs, independent wrapping and service keys, public MCP origin,
mode, creator allowlist, fee-inclusive per-order/cumulative caps, order count and
grant lifetime. Both keys are independent random32-byte unpadded base64url values.
The template fixes the bundled Node path; requests cannot select it.

The signer has exactly one application endpoint, `POST /internal/operation`.
It requires short-lived HMAC authentication over the exact request bytes before
accessing private state. It is reachable over HTTPS and is not a private network.
Mutation request IDs and original proposal attempts persist before venue transport.
An uncertain result requires status/reconciliation; it never permits automatic
resubmission. A fresh native process receives only the selected account's key.

Configure the app's `VERDICT_CONNECTOR_ORIGIN`, exact
`VERDICT_CONNECTOR_APP_ORIGIN` and matching relay secret for the staging branch.
Keep production app settings separate. Vercel environment changes apply only to
new deployments. Use one stable canonical origin per service; preview URLs must
not be accepted through wildcard origin checks.

## Acceptance

Verify the deployed artifacts as well as local tests: OAuth discovery, anonymous
MCP rejection, invalid private HMAC rejection, and an authenticated read-only
private binding lookup. Then complete real staging Privy sign-in, account setup,
owner signatures, original prefilled trade review, approval, SDK submission and
venue status. A synthetic fill or an unsigned native probe is not a live-trade
acceptance result. Record submitted/unfilled and filled outcomes accurately.

The app repository's UX proof and owner-approved Slack-post requirements still
apply before merging its UI into staging. No part of these scripts authorizes a
mainnet trade or a production migration.
