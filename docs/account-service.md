# Privy account connection and agent trading

`verdict-mcp --account-service --connector-config /private/config.json --http 8787`
composes native MCP SDK OAuth endpoints, the Verdict staging connection UI, and the
existing SDK execution gateway. It reuses the existing Privy app. No new identity tenant
or JWT issuer is needed. Local integration tests use ephemeral identities and wallet
keys, real MCP OAuth clients and the actual policy broker with an inert venue.

One authenticated endpoint includes `lighter_*` binary-market research, connection status,
and the single-Lighter `execution_*` lifecycle. Research uses explicit Lighter network and
creator configuration. Execution binds the linked account's exact network and reviewed
scope. The active MCP rejects other venues and paired proposals before dispatch. Missing
depth, unknown fees, and incomplete settlement descriptions remain explicit limitations.

The staging endpoint exists at `https://verdict-mcp-staging.vercel.app/mcp`. Real Privy
sign-in resume and the full account-to-order acceptance test remain blocked. No funded
acceptance or general availability is claimed. Check directory approval and hosted-client
compatibility with each intended client before advertising a public connector.

## Connection flow

1. A client discovers `/mcp` and registers exact redirect URIs through `/register`.
   Public and confidential clients are supported. HTTPS and native HTTP loopback redirects
   are accepted; wildcard, fragment, credentials and arbitrary schemes are refused.
2. `/authorize` binds the exact resource, client, redirect, scopes and S256 challenge.
   It sets an initiating HttpOnly cookie and navigates to the app's `/connect/agent` route.
3. The app obtains a fresh Privy token privately and relays it through its own authenticated,
   CSRF-protected API. The authority verifies ES256, `privy.io`, the configured app audience,
   session claim, issued time and expiry. A Privy token is never an MCP bearer token.
4. The authority inspects deployment-owned broker profiles. A new owner proves control of
   the exact wallet with a transaction-bound signature. A returning owner uses a fresh
   Privy session matched to that saved verified wallet. The reviewed client, resource,
   scopes, accounts, networks, mode, caps and templates remain bound to the transaction.
   A wallet address posted by a model cannot establish ownership.
5. Consent returns one receipt only to the successful app browser. Completion requires both
   that receipt and the original authority cookie. A transaction handle cannot redeem or
   poll a proof. The authority atomically enrolls the account and creates a one-use code.
6. The MCP SDK verifies S256. An atomic code exchange issues opaque resource tokens.
   Access expires after at most five minutes. Refresh rotates, retains narrowed scopes and
   has an absolute lifetime. Reusing a consumed refresh token revokes the whole connection.

With `lighterProvisioner` configured, the Lighter testnet flow also supports a new hosted
venue key. The browser first proves ownership. A separate wallet signature requests test
funds when the owner has no testnet account. Another signature registers a new key in a
free slot from 5 through 254. The browser's existing key in slot 4 stays untouched.
The private signer stores the new key encrypted before returning its public registration
review. A claimed registration can only reconcile, including after a restart.

The owner then signs the exact creator scope, mode, per-order cap, total cap, order count
and expiry. This signature creates bounded broker authority. Final OAuth consent remains
a separate review using the verified signed-in session, without another wallet signature.
Saved account and key setup resume across connection requests and service restarts.
An expired unused permission requires a separately signed renewal of the same limits;
it never repeats funding or key registration. Used or revoked permissions cannot renew
through this pilot flow.

When a returning owner's order-review browser session expires, fresh Privy authentication
restores access to that exact connection's review without another wallet signature.
Authentication never confirms an order. In `per_order` mode, the owner must still click
**Confirm this order** for the exact displayed proposal before it expires.

The browser review shows the outcome, side, exact shares and price, fee reserve and
maximum spend. Settlement rules and protocol identifiers are available in a closed
disclosure. The headline spend rounds up to the next cent; the exact debit remains in
the order details. Multi-outcome labels come from the event metadata entry matching
the exact venue market ID, never from the array position.

An expired, unattempted first-party Lighter IOC buy can request **Refresh quote** from
the signed-in review. This creates a separate unsigned proposal, preserves the original
limit price and spend caps, and requires a fresh confirmation. The parent review ID
provides the stable quote identity; repeat refresh requests return the same child review.
Refreshing never submits, cancels or extends trading permission. Attempted, declined,
uncertain and cancellation requests cannot create replacement trades through this path.
Budget-based proposals allow five minutes for review, capped by market and permission
expiry. The broker still checks current venue data immediately before execution.

Lighter API keys have broader venue powers than trading. Broker limits
are application controls, and the private service holds custody of the hosted API key.
The native registration message binds key, nonce, account and slot, but does not include
a network or review expiry. The application verifies those separately. A renewed review
with an unchanged nonce is not a new cryptographic expiry on that native signature.

Unknown wallets may explicitly connect for research only; those grants never acquire trade
scope when a profile is subsequently provisioned. Start a new reviewed connection instead.
One verified EVM owner must control every account in a profile, and accounts cannot be
shared between Privy subjects. The pilot supports EOA ownership proofs; contract wallets
and other-venue enrollment are unsupported. Lighter ownership comes from its fresh numeric
account's L1 owner. Never infer it from another venue or network. Multiple eligible profiles
fail closed until the operator resolves them.

## Execution and revocation

The operator explicitly chooses `per_order` or `policy` in a private immutable profile.
Both require a previously reviewed bounded broker policy. OAuth consent never creates a
venue key or expands a budget. Lighter testnet key registration and scope authorization
use the separate owner reviews described above. The active kit has no other-venue approval
or execution path.

`per_order` submits one exact order after independent browser authentication and confirmation.
That browser must authenticate the original connection's subject and authorization reference;
an MCP bearer cannot approve its own order. Explicit policy mode can execute a single
Lighter order within its existing reviewed grant without another per-order prompt. The
broker still enforces fresh preflight, budgets, account locks, grant identity/hash, and
durable send attempts. Neither mode exposes paired trading.

The `consumer_lighter` scope supports one Lighter testnet buy IOC at a time. Fresh markets
must match the owner-reviewed creator scope and fresh binary-market metadata. Existing
exact-template grants keep their original matching rules. Consumer enrollment does not
enable paired orders, sells, withdrawals or arbitrary signer calls.

`execution_prepare_lighter_intent` takes `intentId`, `market`, `side` and `maxSpendUSDC`.
The spend cap includes fees. `maxSlippageBps` defaults to 50, or `limitPrice` supplies an
exact market tick. The SDK derives account, key, creator, title and settlement rules from
the verified connection and public venue data. It floors size and rounds fee reserves up.
An intent ID retains its original proposal across retries and restarts. Changed inputs
conflict, and expired proposals are never refreshed under the same intent ID. Keep the
returned proposal for `execution_submit` and `execution_status`. Preparing sends no order.

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
| `appNetwork` | Explicit app network; use `lighter-testnet` for self-service Lighter enrollment |
| `privyAppId` | The app's existing `VITE_PRIVY_APP_ID`, matched exactly |
| `privyVerification` | `{ "kind": "jwks" }` reads bounded public ES256 keys from the exact configured Privy app, with rotation support |
| `privyVerificationKey` | Legacy pinned public SPKI alternative; never a private key |
| `relaySecretEnv` | Name of a private random shared relay secret, at least 32 bytes |
| `profiles` | Dedicated operator account/socket, grant ID/hash, allowed accounts and chosen mode |
| `storage` | Explicit `local` with separate owner-only `0700` state directories, or `postgres` with fixed deployment/database IDs and a connection string environment variable. Runtime never initializes missing PostgreSQL state. |
| `lighterProvisioner` | Explicit `local_socket` with private socket paths, or `hosted_signer` with a fixed HTTPS origin, deployment ID and service secret environment variable. Browser input never selects the destination. |

In Vercel server-only staging settings, configure `VERDICT_CONNECTOR_ORIGIN`,
`VERDICT_CONNECTOR_APP_ORIGIN` and `VERDICT_CONNECTOR_RELAY_SECRET`. The relay secret
must match the authority's environment and must never use a `VITE_` name. Configure the
actual app origin in the existing Privy dashboard's allowed login origins. Pinned SPKI
rotation requires a coordinated authority restart. Changing the relay secret requires
coordinated app/authority configuration and invalidates stored confidential-client secrets.

Provision a dedicated broker using the [broker setup](../local-runner/README.md), review
canonical templates and issue its grant through the operator approval command. Call
`connectExecution({expectedMode:'policy',expectedGrantId,socketPath}).inspectConnection()`
to get the exact policy hash, original and remaining limits, owner, agent and readiness.
Copy those identities into the private profile. Enable only that reviewed profile. The
legacy profile path does not provision venue keys. The optional private Lighter provisioner
supports the separate self-service testnet flow. Mainnet enrollment and funding are unsupported.

The connection protocol is `verdict-connect/2`. The app copies
`packages/mcp/src/connect-contract.ts` as a leaf schema so the two repositories build
independently. Compare bytes and pin the SDK commit when releasing both sides.

## Run and operate

The runtime uses Node 22.13+. Choose a storage and signer deployment explicitly:

- With `local` storage, use one persistent instance. The authority holds an exclusive
  SQLite lock, and a second writer fails closed. Preserve state files, markers, and journals
  across restarts. Do not deploy this local-storage configuration as ephemeral functions.
- With provisioned `postgres` storage and a `hosted_signer`, the public authority can run
  on Vercel. Staging uses a free Neon database and a separate private signer with restricted
  database authority. Runtime processes never initialize missing schemas. Follow the
  [deployment guide](../deploy/README.md) for role separation and explicit provisioning.

Missing, replaced, symlinked, permissive, or corrupt local state fails closed. Back up
public authority, jobs, and private broker state consistently. Restoring an old backup can
restore old authorization and requires incident review and credential revocation before
resuming.

For the persistent local deployment, the [container build](../examples/connector/Dockerfile.account-service) requires an explicitly
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
