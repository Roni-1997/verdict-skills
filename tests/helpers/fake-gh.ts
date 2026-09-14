// A stand-in `gh` on PATH, so the pin checks' GitHub leg (scripts/check-engine-drift.mjs and
// scripts/check-api-contract.mjs) runs without the network. 'serve' answers
// `gh api repos/<repo>/contents/<path>?ref=<sha>` with this checkout's pinned copies the way GitHub does (base64
// content plus blob sha), looking the path up across every pin record given; the other modes fail the way gh fails.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The pin records whose files the fake serves: the engine's and the API contract's. */
export const PIN_RECORDS = ['packages/engine/UPSTREAM.json', 'packages/core/api-contract/UPSTREAM.json'] as const;

export type FakeGhMode = 'serve' | 'not_found' | 'offline' | 'unauthenticated';

/** Returns the directory to put on PATH (alone, so the real gh is never reached). */
export function fakeGh(mode: FakeGhMode, records: readonly string[] = PIN_RECORDS): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  const script = join(dir, 'gh.mjs');
  const bodies: Record<FakeGhMode, string> = {
    serve: [
      "import { readFileSync } from 'node:fs';",
      "import { createHash } from 'node:crypto';",
      "const m = /contents\\/(.+)\\?ref=/.exec(process.argv[3] ?? '');",
      `const records = ${JSON.stringify(records.map((r) => join(ROOT, r)))};`,
      "const files = records.flatMap((r) => JSON.parse(readFileSync(r, 'utf8')).files);",
      'const f = files.find((x) => x.upstream === m?.[1]);',
      "if (!f) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }",
      `const bytes = readFileSync(${JSON.stringify(ROOT)} + f.local);`,
      "const sha = createHash('sha1').update('blob ' + bytes.length + '\\0').update(bytes).digest('hex');",
      "process.stdout.write(JSON.stringify({ encoding: 'base64', content: bytes.toString('base64'), sha }));",
    ].join('\n'),
    not_found: "process.stderr.write('gh: No commit found for the ref 0000000000000000000000000000000000000000 (HTTP 404)\\n'); process.exit(1);",
    offline: "process.stderr.write('error connecting to api.github.com\\ncheck your internet connection or https://githubstatus.com\\n'); process.exit(1);",
    unauthenticated: "process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\\n'); process.exit(4);",
  };
  writeFileSync(script, `${bodies[mode]}\n`);
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  return dir;
}
