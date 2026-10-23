# Privy account connection and agent trading

`verdict-mcp --account-service --connector-config /private/config.json --http 8787`
composes native MCP SDK OAuth endpoints, the Verdict staging connection UI, and the
existing SDK execution gateway. It reuses the existing Privy app. No new identity tenant
or JWT issuer is needed. Local integration tests use ephemeral identities and wallet
keys, real MCP OAuth clients and the actual policy broker with an inert venue.

One authenticated endpoint includes HL research, `lighter_*` binary-market research,
`strategy_*` conditional analysis/paper tools, connection status and `execution_*` lifecycle.
Research networks are configured independently through the existing environment settings;
execution uses the exact linked proposal network. Strategy tools still do not verify
settlement equivalence, authorize trades or guarantee fills/profit. Missing venue data,
unknown fees and unmatched contract rules remain explicit research limitations.

The implementation has not been deployed or accepted with funded accounts. App directory
approval and hosted-client compatibility must be checked with each intended client before
advertising a public connector. Standard OAuth support alone does not establish approval.

## Connection flow

1. A client discovers `/mcp` and registers exact redirect URIs through `/register`.
   Public and confidential clients are supported. HTTPS and native HTTP loopback redirects
   are accepted; wildcard, fragment, credentials and arbitrary schemes are refused.
2. `/authorize` binds the exact resource, client, redirect, scopes and S256 challenge.
   It sets an initiating HttpOnly cookie and navigates to the app's `/connect/agent` route.
3. The app obtains a fresh Privy token privately and relays it through its own authenticated,
   CSRF-protected API. The authority verifies ES256, `privy.io`, the configured app audience,
   session claim, issued time and expiry. A Privy token is never an MCP bearer token.
4. The authority inspects deployment-owned broker profiles. The browser proves control of
   the exact owner wallet with a fresh transaction-bound signature. The reviewed client,
   resource, scopes, accounts, networks, mode, caps and templates are bound to that proof.
   A wallet address posted by a model cannot establish ownership.
5. Consent returns one receipt only to the successful app browser. Completion requires both
   that receipt and the original authority cookie. A transaction handle cannot redeem or
   poll a proof. The authority atomically enrolls the account and creates a one-use code.
6. The MCP SDK verifies S256. An atomic code exchange issues opaque resource tokens.
   Access expires after at most five minutes. Refresh rotates, retains narrowed scopes and
   has an absolute lifetime. Reusing a consumed refresh token revokes the whole connection.

Unknown wallets may explicitly connect for research only; those grants never acquire trade
scope when a profile is subsequently provisioned. Start a new reviewed connection instead.
One verified EVM owner must control every account in a profile, and accounts cannot be
shared between Privy subjects. The pilot supports EOA ownership proofs; contract wallets
and Polymarket enrollment are unsupported. Lighter ownership comes from its fresh numeric
account's L1 owner; it is never guessed from a Hyperliquid address. HL and Lighter networks
remain independent. Multiple eligible profiles fail closed until the operator resolves them.

## Execution and revocation

The operator explicitly chooses `per_order` or `policy` in a private immutable profile.
Both require a previously reviewed bounded broker policy. OAuth consent never creates a
venue key, expands a budget, changes a template or authorizes a withdrawal. The app offers
a separate `Verdict Hosted` Hyperliquid agent approval when required. Builder allowances
and missing Lighter key registration remain visible blockers, resolved separately.

`per_order` submits one exact order after independent browser authentication and confirmation.
That browser must authenticate the original connection's subject and authorization reference;
an MCP bearer cannot approve its own order. Policy mode can execute reviewed templates without
another prompt, including sequential non-atomic pairs. The broker still enforces fresh
preflight, budgets, account locks, grant identity/hash and durable send attempts.

Disconnect from `/connect/agent` revokes OAuth access, refresh and browser sessions immediately.
Pending jobs retain their originating authorization reference; a later login or same-subject
connection cannot revive them. Revocation prevents claims and dispatches that have not crossed
their execution boundary. An already claimed or in-flight venue request can complete or remain
uncertain; revocation cannot unsend it. Reconcile the original proposal and never auto-retry.
Venue key revocation is a separate venue action. Privy logout does not revoke a previously
consented agent delegation: use disconnect or the token revocation endpoint.

## Configure the staging pilot

Use the actual staging deployment, not stale `main`. Copy the
[private configuration example](../examples/connector/account-service.example.json)
outside the checkout and make it owner-only `0600`. All example hosts and IDs are placeholders.

| Authority setting | Source |
|---|---|
| `publicOrigin` | The intended HTTPS connector origin; exact resource is this origin plus `/mcp` |
| `appOrigin` | Actual staging app HTTPS origin, with the new app route/relay deployed |
| `appNetwork` | Explicit HL app network; use `testnet` for initial acceptance |
| `privyAppId` | The app's existing `VITE_PRIVY_APP_ID`, matched exactly |
| `privyVerificationKey` | The same Privy app's ES256 public SPKI verification key; never a private key |
| `relaySecretEnv` | Name of a private random shared relay secret, at least 32 bytes |
| `profiles` | Dedicated operator account/socket, grant ID/hash, allowed accounts and chosen mode |
| `stateDir`, `gatewayJobsDir` | Separate persistent, owner-only `0700` directories |

In Vercel server-only staging settings, configure `VERDICT_CONNECTOR_ORIGIN`,
`VERDICT_CONNECTOR_APP_ORIGIN` and `VERDICT_CONNECTOR_RELAY_SECRET`. The relay secret
must match the authority's environment and must never use a `VITE_` name. Configure the
actual app origin in the existing Privy dashboard's allowed login origins. Verification-key
rotation requires a coordinated authority restart; changing the relay secret requires
coordinated app/authority configuration and invalidates stored confidential-client secrets.

Provision a dedicated broker using the [broker setup](../local-runner/README.md), review
canonical templates and issue its grant through the operator approval command. Call
`connectExecution({expectedMode:'policy',expectedGrantId,socketPath}).inspectConnection()`
to get the exact policy hash, original and remaining limits, owner, agent and readiness.
Copy those identities into the private profile. Enable only that reviewed profile. The
connection UI cannot provision unknown users' venue keys or fund their trading accounts.

The connection protocol is `verdict-connect/1`. The app copies
`packages/mcp/src/connect-contract.ts` as a leaf schema so the two repositories build
independently. Compare bytes and pin the SDK commit when releasing both sides.

## Run and operate

Use Node 22.13+ on one persistent instance with a local filesystem. The authority takes
an exclusive SQLite lock for its lifetime; a second writer fails closed. Do not run this
stateful pilot as ephemeral Vercel functions or multiple replicas. The app relay can remain
on Vercel. State files, markers and journals must survive process/container restarts.
Missing, replaced, symlinked, permissive or corrupt state fails closed. Back up authority,
jobs and broker state consistently; restoring an old backup can restore old authorization
state and requires incident review and credential revocation before resuming.

The [container build](../examples/connector/Dockerfile.account-service) requires an explicitly
reviewed Node image digest. Build from a clean tracked checkout, without credentials or state
in the build context. Run as the dedicated unprivileged broker UID, with a read-only
root filesystem, dropped capabilities and `no-new-privileges`. Mount only a `0600` config,
the two writable state directories and the private broker socket directory. Never mount
broker keys into this service. Bind its port to loopback and preserve the configured Host
through a TLS proxy; the [Caddy example](../examples/connector/Caddyfile.example) illustrates
the routing. Provision DNS/TLS for that chosen origin before enabling external traffic.
Do not publish port 8787 directly. Do not log request bodies, Authorization headers, cookies
or callback query strings. Apply proxy connection/read/header timeouts and rate limits;
native OAuth endpoints also have bounded per-peer limits. Behind a proxy, their default
peer limit is shared by clients of that proxy: size it deliberately before broader rollout.

The authority stores only hashes of opaque bearer secrets, codes, receipts and cookies.
Confidential OAuth client secrets are encrypted with a separate derived key. Trading secrets
remain exclusively in the broker. HTTPS origins are required; loopback HTTP is an explicit
test-only configuration. Staging acceptance must verify real login/callbacks, desktop/mobile
consent UI, ownership and venue registration, then a separately authorized testnet trade.
