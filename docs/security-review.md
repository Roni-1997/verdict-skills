# Pre-merge security review

Reviewed on 2026-10-22. Two independent code reviewers examined proposal validation,
account binding, signing, per-order approval, fixed network endpoints, credential/error
handling, journal permissions, concurrency and restart behavior. The review used source,
dummy-data reproductions, SDK contract tests and public dependency advisory databases.
It did not use real credentials, private account reads or funded trades.

## Findings fixed

- HL local execution previously mapped `yes` and `no` to the first and second assets even
  when venue labels represented teams or Over/Under. A local reproduction passed preflight
  for the wrong semantic label. Execution now requires canonical Yes/No labels and checks
  the selected side index, name, coin and native asset against the approved outcome.
- The HTTP wrapper buffered unbounded request bodies. It now rejects declared and chunked
  bodies above 1 MiB before opening an MCP session. A real HTTP test checks both paths and
  verifies the server continues serving requests.
- Advisory scans found affected JavaScript packages and an old urllib3 forced by the
  Lighter SDK metadata. The MCP SDK, test runner and compatible transitive dependencies
  were updated. The Python lock uses the explicit security override described in
  [the runner guide](../local-runner/README.md). Official SDK contracts passed with it.

The final locked JavaScript and installed Python environments had zero known advisories
in the scans performed on the review date. Gitleaks found no secrets in the PR's committed
history. These results do not rule out unknown vulnerabilities, advisory coverage gaps,
or secrets outside the reviewed history.

## Verification and remaining limits

The required suite passed 453 TypeScript tests and 60 broker tests. The separate installed
SDK suite passed 28 tests. Tests include actual CLI/MCP interaction, native signing with
temporary keys, mock transports, process-crash recovery and public market reads. The new
HL and HTTP regressions failed before their respective fixes.

Hosted tools remain keyless and cannot submit trades. The local CLI requires a distinct
operator approval for every order. Direct Python users supply their own approval callback;
they must keep that process and credentials outside an agent's control. A malicious
process running as the same local user is outside the journal's protection boundary.

Venue metadata and the pinned SDKs remain trusted boundaries. Polymarket fee metadata
uses the pinned SDK's documented-in-code absent/null `fd` interpretation as zero; the
review found no evidence of a charged market contradicting that interpretation. Fee
reserves are estimates, not venue-enforced ceilings. Cross-venue fills are non-atomic,
fee-short or uncertain net inventory halts, and recovery requires a separately approved
proposal. Funded acceptance, private permissions and the future browser wallet-connect
experience remain unverified. No package publishing or deployment is part of this review.
