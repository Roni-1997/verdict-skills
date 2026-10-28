# Hosted trading connector

`verdict-mcp --hosted-execution` exposes authenticated account discovery, proposal
preparation, review, preflight, submission, status and exact cancellation over Streamable
HTTP. It uses the same `connectExecution()` client and official SDK broker as local agents.
Trading keys stay in the separate private broker process.

The active hosted kit exposes Lighter binary research and single-Lighter execution.
The staging account-service endpoint exists at `https://verdict-mcp-staging.vercel.app/mcp`.
Clients connect with that URL through OAuth; see [the hosted setup](../README.md#connect-the-hosted-mcp).
Local tests use an ephemeral OAuth issuer, real MCP clients, the SDK broker, and an inert
venue. No funded acceptance or directory approval is claimed. `mcp.hyperverdict.xyz`
below is an example origin for the alternative managed-provider deployment.

## Identity and trading authority

For Verdict's existing Privy login, use the [first-party account service](account-service.md)
and its matching staging app connection route. `--account-service` supplies durable OAuth
and verified ownership enrollment while keeping this execution gateway and broker unchanged.
The rest of this section describes the alternative external-provider `--hosted-execution`
mode, which remains supported with its strict JWT audience and scope checks.

Reuse the product's existing identity provider when it can support the required OAuth
flow. Auth0 is one compatible example, with
[MCP authentication](https://auth0.com/blog/auth0-auth-for-mcp-servers-generally-available/)
and resource audience configuration. It is not a required new login system. The connector
accepts standards-based discovery, PKCE and RS256/ES256 JWTs; it contains no authorization
server or user database.

A wallet-login provider such as Privy supplies product identity, which still needs an
MCP authorization integration. [Privy access tokens](https://docs.privy.io/authentication/user-authentication/access-tokens)
have the Privy app ID as their audience. This gateway requires its exact MCP URL as the
audience and separate read/trade scopes, as required by [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
Do not pass a product-login token through or disable audience/scope checks to make it fit.
An integration must verify the existing identity, bind verified account ownership, collect
MCP consent and issue resource-specific authority. This repository does not implement
that integration in external-provider mode; the separate account-service mode now does.

An access token must match the configured issuer and exact MCP resource audience, include
an expiry and subject, and carry `verdict:read`. Submission and cancellation additionally
require `verdict:trade`. A verified subject must have an enabled operator binding before
the connector can access a broker. An OAuth token does not create a trading grant.

The operator binding fixes the subject, accounts, networks, Lighter key index where
applicable, private socket, broker grant ID and gateway mode. Tool inputs cannot select
another socket, issue a grant, switch modes or expand an account binding. Each binding
has a distinct broker socket and accounts; shared account bindings are refused.

| Gateway mode | Submission | Underlying broker |
|---|---|---|
| `per_order` | One exact order requires an independent signed-in browser confirmation. Cancellation requires its own confirmation. | A previously approved bounded `policy` grant |
| `policy` | The agent may submit a single Lighter order inside the operator's existing grant without another per-order browser prompt. | A previously approved bounded `policy` grant |

Both active modes accept one Lighter order. Other venues and paired proposals are
rejected at the MCP boundary. Hosted `per_order` is independent browser consent within a
bounded broker policy. Local per-order execution uses the operator's terminal. A model
cannot change mode, issue a grant, expand limits, or approve the review itself.

## Configure the managed provider

1. Reuse the verified product identity through an MCP-capable authorization integration.
   If no product identity exists, choose a managed provider. Verify its issuer, account
   subjects and API permissions. The kit does not replace the app's existing login system.
2. Register a custom API resource, for example `https://mcp.hyperverdict.xyz/mcp`, with
   `verdict:read` and `verdict:trade` scopes and signed, short-lived JWT access tokens.
   The resource must equal `publicOrigin + /mcp`; a browser ID token is not an API token.
3. Enable the provider's supported MCP client registration flow for the intended clients
   and its resource-indicator support. For Auth0, check the
   [Resource Parameter Compatibility Profile](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0).
   Follow the provider and client requirements for CIMD or dynamic client registration;
   this connector implements the resource server, not client registration.
4. Register a separate browser application with authorization code + S256 PKCE, callback
   `https://mcp.hyperverdict.xyz/auth/callback`, and the same custom API permissions.
   A confidential client must support `client_secret_post`; put its secret in the
   environment variable named by `browserClientSecretEnv`. The JSON stores only that
   variable's name. A public PKCE client can omit that field if the provider advertises
   token endpoint authentication method `none`.
5. Use the provider's verified `sub` value when provisioning a binding. Matching email
   text or a model-supplied wallet address does not establish account ownership.

The connector publishes OAuth protected-resource metadata at
`/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource`.
The authorization server supplies discovery, authorization, token and JWKS endpoints.
Discovery issuer and JWT issuer must exactly match the configured value, including any
trailing slash. Provider redirects during discovery and token exchange are refused.

## Provision a trading connection

Follow the [broker setup](../local-runner/README.md) to install its pinned SDKs and
configure dedicated venue credentials in the broker's operator environment. Review exact
proposal templates, issue a bounded grant, and start a policy broker with that grant:

```sh
cd local-runner
.venv/bin/python -m verdict_broker grant-create --template ../proposal.json --max-debit-usdc 100 --max-orders 20 --expires-at <Unix-milliseconds> --cancel-own-orders
.venv/bin/python -m verdict_broker serve --mode policy --grant-id <issued-grant-id> --socket /private/operator/account/broker.sock
```

The grant creation command requires real operator approval. Use a private 0700 socket
parent and preserve broker state. Budgets, templates and cleanup permission remain the
broker's authority. The SDK carries the operator-pinned `expectedGrantId` on every
hosted broker request, and the selected broker rejects another grant before any mutation.
This prevents a restart at the same socket from spending a replacement grant.
The broker independently performs fresh preflight and its final authorization check
before transport. No hosted tool provisions credentials, wallets, allowances or grants.

Copy [the example configuration](../examples/connector/config.example.json) into an
operator-owned file outside the repository and make it 0600. Replace every placeholder,
set exact accounts and the issued grant ID, and enable only reviewed bindings. Choose
`per_order` or `policy` explicitly for each binding. Both modes use a policy broker.
The example binding is disabled and contains no working grant or credentials.

The config must be a regular owned file; symlinks and group/world permissions are refused.
State paths and sockets must be absolute. HTTPS is required. `allowInsecureLocalhost`
permits HTTP only for explicit loopback testing. It does not permit a public HTTP origin.

## Start the connector

Requires Node 22.13+ (SQLite support), the repository's pnpm version, and a built workspace:

```sh
pnpm install --frozen-lockfile
pnpm run build
node packages/mcp/dist/bin.js --hosted-execution --connector-config /private/operator/connector.json --http 8789
```

Place a TLS reverse proxy in front of the loopback listener. Preserve the configured
public Host header and enforce ordinary request, connection and login rate limits. The
connector does not trust forwarded headers to choose its origin. Route `/mcp`, discovery,
`/auth/callback`, `/review/*` and `/healthz` to the same instance. Do not expose broker
sockets or credential environments. Bind `--host 0.0.0.0` only inside the intended private
service network. `GET /healthz` reports process health, not funded account readiness.

In this external-provider mode, browser login state and short-lived sessions are in
process memory, so use one connector instance per configuration. A restart requires browser sign-in again.
Gateway jobs and broker attempts are durable. Preserve both local state directories
through restarts, and do not deploy replicas with separate copies of the job database.
The first-party account service also supports provisioned PostgreSQL and an isolated
hosted signer. Its Vercel staging deployment is described in the [deployment guide](../deploy/README.md).

## Connect ChatGPT or Claude

Use the deployed HTTPS `/mcp` URL as a custom remote connector and follow the host's OAuth
sign-in flow. Official setup instructions:
[ChatGPT custom connection](https://developers.openai.com/plugins/deploy/connect-chatgpt),
[Claude remote connector](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
A consumer cloud client cannot reach a user's loopback URL. Test through an authenticated
public HTTPS deployment or an explicitly configured development tunnel.

Submission returns either the existing execution status or `approval_required` with an
exact review URL. Compatible MCP Apps hosts receive a small order-status card linking to
that review page; other clients can show the same URL as text. The card does not approve
orders. There is no `confirm` MCP tool and no model-controlled approval field.

The browser page performs its own OIDC code/PKCE/state/nonce flow, validates the ID and API
tokens for the same subject, and uses an opaque HttpOnly, Secure, SameSite cookie. An MCP
bearer token cannot open or post the approval page. Confirmation checks the signed-in
owner, exact Origin and CSRF token. Opening the page sends no order. A separate account
cannot review another user's job even if it obtains the URL.

This implements protocol support and a review resource. It does not claim an installed
ChatGPT/Claude app, a public listing, a production wallet-linking flow, or native host UI
acceptance. Public distribution requires the host's review. In particular, OpenAI's
[plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) list
investment trade execution among prohibited services for directory submissions. Treat
that as a distribution constraint; describing a submission tool as research does not
change what it does. Confirm the intended host permits the integration before launch.

## Recovery and configuration changes

The gateway commits a single durable dispatch claim before any SDK mutation. Concurrent
confirmations, repeated tools, lost responses and gateway restarts do not send it again.
After an ambiguous result, keep the original proposal and use `execution_status`.
Never create a replacement proposal merely because a request timed out. The broker's
own durable attempt fence remains independent of the gateway journal.

A partial or uncertain single-order attempt does not prove that no position exists.
Keep its original proposal and broker records. Reconciliation must establish the actual
order state before any newly authorized trade can replace the intended action. The active
kit has no automatic hedge, unwind, or paired recovery workflow.

Approval expiry cannot be extended by repeating submit. Declining is final for that job.
Cancellation is a distinct job for leg 0 of the original single-Lighter proposal, allowed
only for a previously attempted owned submission. Its confirmation TTL is independent of proposal expiry; cleanup still needs
the broker's retained own-order cancellation authority and can race fills.

Bindings are loaded at startup. To disable or change one, update the private config and
restart. A changed binding fingerprint invalidates old approvals and prevents resubmission
under a different grant. Reconcile old attempts with the original broker and operator
records. Revoke the broker grant to block new sends independently of OAuth/session
expiry. Neither revocation nor a gateway restart recalls an order already transmitted.

## Verify locally

```sh
pnpm run check
VERDICT_BROKER_PYTHON=local-runner/.venv/bin/python pnpm run check:broker:sdk
```

Hosted tests cover signed OAuth tokens, wrong audiences, scope enforcement, real PKCE
browser login, user isolation, CSRF and Origin rejection, concurrent confirmations,
SDK-to-broker dispatch, policy mode, exact cancellation, and durable restart recovery.
Separate state tests race two processes against one claim and fail closed for missing or
corrupt state. The test issuer and venue are temporary fixtures; no funded order is sent.
