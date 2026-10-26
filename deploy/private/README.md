# Private signer Vercel package

Assemble a clean deployment directory from pinned build artifacts:

```sh
node scripts/package-private-vercel.mjs \
  --cli ../hosted-lighter/cli-runtime-private \
  --node-runtime ../hosted-lighter/node-runtime \
  --out ../hosted-lighter/vercel-private-staging
```

Build the SDK and its production CLI deployment first. The packager uses the pinned esbuild dependency to bundle CLI dependencies into one ES module, so Vercel's default exclusion of node_modules cannot remove them. It verifies the official Node22 Linux x64 archive and binary against the committed hashes, checks the ELF architecture, copies only explicit Python modules and the complete pinned requirements lock, preserves dependency licenses, and validates the packaged CLI through the local Node22 runtime. It writes a deterministic file inventory and SHA256 manifest. It refuses an existing output directory and performs no install, provider operation, credential read or deployment.

The API wrapper defines a top-level class handler(VercelHandler), which Vercel's Python analyzer detects; an assignment alias is not detected. The packager rejects that mistake before producing an artifact. The wrapper fixes local-runner's import path and the bundled Node path at module startup. The function exposes only authenticated POST /internal/operation. The string includeFiles glob explicitly retains Python vendor dependencies and native libraries for fresh child processes. Python3.12 and Node22 are fixed; the installed Python dependencies come from requirements.txt, copied byte for byte from local-runner/requirements.lock including pinned Git commits and distribution hashes.

Set the private signer runtime environment and provision the database through the separate administrative migration process described in docs/account-service.md. Credentials are never copied into this package. The public MCP project must not receive the private DSN, wrapping key, or any native account key. For a read-only deployment check, an authenticated operation binding for the unused synthetic subject did:privy:deploymentProbe returns binding:null without allocating a key or allowance.

Packaging verification proves the local artifact. Actual Vercel acceptance must also confirm Python vendor files, fresh multiprocessing children, bundled Linux Node execution and canonical CLI validation. No diagnostic HTTP route is included in this production package.
