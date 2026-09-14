// The skill face is documentation, so its tests check structure and safety text: every CLI command in
// USAGE has a table row and a reference file, the required sections exist, no confirmation-skip flag is
// taught anywhere, the unsigned nature of the payloads is stated, the confirmation protocol, the analysis-to-trade
// boundary and the signer hand-off are one sentence each across the docs, and the installer is a plain shell
// script that builds from this repository and pipes nothing from the network into a shell. uninstall.sh
// needs no build, so it also runs against scratch CLAUDE_HOMEs: it must remove exactly the block
// install.sh wrote and nothing the user owns.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { USAGE } from '../packages/cli/src/index.js';
import { TOOL_DOCS } from '../packages/core/src/index.js';

const ROOT = new URL('../', import.meta.url);
const path = (rel: string): string => fileURLToPath(new URL(rel, ROOT));
const read = (rel: string): string => readFileSync(path(rel), 'utf8');

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`${what} is missing`);
  return value;
}

/** The `## Verdict` block a script embeds as CLAUDE_MD_BLOCK=$(cat <<'BLOCK' ... BLOCK). */
function heredocBlock(script: string, what: string): string {
  return must(/CLAUDE_MD_BLOCK=\$\(cat <<'BLOCK'\n([\s\S]*?)\nBLOCK\n\)/.exec(script)?.[1], what);
}

/** process.env without one variable, for scripts that read it as an override. */
function envWithout(name: string): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== name));
}

function parseFrontmatter(text: string): Record<string, string> {
  const block = must(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1], 'SKILL.md frontmatter');
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[line.slice(0, i).trim()] = value;
  }
  return out;
}

/** Headings of one level, lowercased, so section checks do not depend on exact wording. */
function headings(md: string): string[] {
  return [...md.matchAll(/^## (.+)$/gm)].map((m) => must(m[1], 'heading').toLowerCase());
}

const SKILL_DIR = 'skills/verdict/';
const skill = read(`${SKILL_DIR}SKILL.md`);
const frontmatter = parseFrontmatter(skill);
const referenceFiles = readdirSync(path(`${SKILL_DIR}references/`)).filter((f) => f.endsWith('.md'));
const scriptFiles = readdirSync(path(`${SKILL_DIR}scripts/`)).filter((f) => f.endsWith('.sh'));
const skillDocs = [skill, ...referenceFiles.map((f) => read(`${SKILL_DIR}references/${f}`))];
const usageCommands = [...USAGE.matchAll(/^ {2}verdict ([a-z-]+)/gm)].map((m) => must(m[1], 'usage command'));

describe('SKILL.md frontmatter', () => {
  it('names the skill, pins the version and lists the activation triggers', () => {
    expect(frontmatter.name).toBe('verdict');
    expect(frontmatter.version).toBe('0.1.0');
    const description = must(frontmatter.description, 'description');
    for (const trigger of ['Verdict', 'HIP-4', 'outcome market', 'Hyperliquid prediction market', 'Verdict venue or its markets', 'compare to Polymarket', 'compare to Kalshi', 'builder code']) {
      expect(description).toContain(trigger);
    }
  });
  it('carries parseable OpenClaw metadata that requires the verdict binary', () => {
    const metadata = JSON.parse(must(frontmatter.metadata, 'metadata')) as { openclaw?: { requires?: { bins?: string[] } } };
    expect(metadata.openclaw?.requires?.bins).toEqual(['verdict']);
  });
});

describe('every CLI command has a table row and a reference', () => {
  it('reads twelve commands out of USAGE, the four cross-venue ones included', () => {
    expect(usageCommands).toEqual(['markets', 'market', 'book', 'quote', 'compare', 'fair-value', 'hedges', 'opportunities', 'positions', 'builder-status', 'approve-builder-fee-payload', 'build-order']);
  });
  for (const cmd of usageCommands) {
    it(`maps "${cmd}" to a CLI invocation, an MCP tool and references/${cmd}.md`, () => {
      const row = skill.split('\n').find((line) => line.startsWith('|') && line.includes(`\`verdict ${cmd}`) && line.includes(`references/${cmd}.md`));
      expect(row, `table row for ${cmd}`).toBeDefined();
      expect(existsSync(path(`${SKILL_DIR}references/${cmd}.md`))).toBe(true);
      const reference = read(`${SKILL_DIR}references/${cmd}.md`);
      expect(reference).toContain(`verdict ${cmd}`);
      expect(reference.toLowerCase()).toContain('## errors');
      expect(reference).toContain('```json');
    });
  }
  it('names every MCP tool from TOOL_DOCS in the command table', () => {
    for (const tool of Object.keys(TOOL_DOCS)) expect(skill).toContain(`\`${tool}\``);
  });
  it('lists exactly the read-only commands as read only', () => {
    const section = must(/## Read-only commands\n\n([^\n]+)/.exec(skill)?.[1], 'read-only list');
    const readOnly = Object.entries(TOOL_DOCS).filter(([, doc]) => doc.readOnly).length;
    for (const cmd of ['markets', 'market', 'book', 'quote', 'compare', 'fair-value', 'hedges', 'opportunities', 'positions', 'builder-status']) expect(section).toContain(`\`${cmd}\``);
    expect(section.match(/`[a-z-]+`/g)).toHaveLength(readOnly);
    expect(section).not.toContain('build-order');
    expect(section).not.toContain('approve-builder-fee-payload');
  });
  it('presents the cross-venue commands as available, with the low-confidence rule, and no longer says they are missing', () => {
    for (const doc of [skill, ...referenceFiles.map((f) => read(`${SKILL_DIR}references/${f}`)), read('README.md')]) {
      expect(doc).not.toMatch(/not (a command |available )?in this CLI version/i);
      expect(doc).not.toMatch(/comparison command is not available/i);
    }
    expect(skill).toContain('A low-confidence match must be presented with its confidence and reasons and never as a bare number');
    const boundary = must(/## Analysis-to-trade boundary\n([\s\S]*?)\n## /.exec(skill)?.[1], 'boundary section');
    for (const cmd of ['compare', 'fair-value', 'hedges', 'opportunities']) expect(boundary).toContain(`\`${cmd}\``);
    for (const f of ['compare.md', 'opportunities.md']) {
      const doc = read(`${SKILL_DIR}references/${f}`);
      expect(doc).toContain('never as a bare number');
      expect(doc).toContain('`confidence`');
      expect(doc).toContain('`reasons`');
      expect(doc).toMatch(/`gap`[^\n]*null/);
    }
    for (const f of ['compare.md', 'fair-value.md', 'hedges.md', 'opportunities.md']) {
      const doc = read(`${SKILL_DIR}references/${f}`);
      expect(doc).toContain('recorded fixtures');
      expect(doc).toContain('injected fetch');
      expect(doc).toContain('2026-09-13T21:31:31Z');
      expect(doc).toMatch(/\| 3 \| `\{"error":"upstream"/);
    }
    // The three price-bearing references say what an unpriced (never traded) Verdict market looks like; hedges carry no price.
    for (const f of ['compare.md', 'fair-value.md', 'opportunities.md']) expect(read(`${SKILL_DIR}references/${f}`)).toContain('never traded');
    expect(read(`${SKILL_DIR}references/fair-value.md`)).toContain('"available": false');
    expect(read(`${SKILL_DIR}references/hedges.md`)).toContain('"directionForYes": "short"');
    expect(read(`${SKILL_DIR}references/opportunities.md`)).toContain('"priced": false');
  });
  it('writes paths relative to the skill directory, says what that directory is, and every one resolves to a file', () => {
    // Claude Code does not expand OpenClaw's {baseDir}; relative paths work in both hosts once the base is stated.
    expect(skill).not.toContain('{baseDir}/');
    expect(skill).toContain('relative to this skill\'s directory');
    expect(skill).toContain('`~/.claude/skills/verdict` after `install.sh`');
    expect(skill).toContain('`skills/verdict` in the clone');
    expect(skill).toContain('OpenClaw calls that folder `{baseDir}`');
    const refs = new Set([...skill.matchAll(/`((?:references|scripts)\/[\w-]+\.(?:md|sh))`/g)].map((m) => must(m[1], 'relative path')));
    expect(refs.size).toBeGreaterThan(8);
    for (const rel of refs) expect(existsSync(path(`${SKILL_DIR}${rel}`)), rel).toBe(true);
  });
  it('ships the sign-and-submit and setup references', () => {
    expect(referenceFiles).toContain('sign-and-submit.md');
    expect(referenceFiles).toContain('setup.md');
  });
});

describe('required sections', () => {
  const h = headings(skill);
  it('has the confirmation protocol, analysis-to-trade boundary, banned behaviours, anti-loop rules and credentials', () => {
    expect(h.some((x) => x.includes('two-message'))).toBe(true);
    expect(h.some((x) => x.includes('analysis-to-trade'))).toBe(true);
    expect(h.some((x) => x.includes('banned'))).toBe(true);
    expect(h.some((x) => x.includes('anti-loop'))).toBe(true);
    expect(h.some((x) => x.includes('credentials'))).toBe(true);
    expect(h.some((x) => x.includes('routing gate'))).toBe(true);
  });
  it('states the two-message rule as GOAL.md does', () => {
    const section = must(/## Signable commands: the two-message rule\n([\s\S]*?)\n## /.exec(skill)?.[1], 'two-message section');
    for (const item of ['settlement rule text', 'the side', 'the price', 'the size', 'the notional', 'the maximum loss', 'cents per $1,000', 'the builder address', 'END your message', 'NEW message']) {
      expect(section).toContain(item);
    }
    expect(section).toContain('Never fabricate the confirmation');
  });
  it('keeps analysis and order building in different turns', () => {
    const section = must(/## Analysis-to-trade boundary\n([\s\S]*?)\n## /.exec(skill)?.[1], 'boundary section');
    expect(section).toContain('do not run `build-order`');
    expect(section).toContain('next turn');
  });
  it('bans fabricated confirmations, hosted signing and bare cross-venue numbers', () => {
    const section = must(/## Banned behaviours\n([\s\S]*?)\n## /.exec(skill)?.[1], 'banned section');
    expect(section).toContain('No confirmation-skip flag exists');
    expect(section).toContain('Never fabricate');
    expect(section).toContain('hosted');
    expect(section).toContain('low-confidence cross-venue match');
    expect(section).toContain('Polymarket, Kalshi or Deribit');
  });
  it('documents the credentials with the agent key local-only and never hosted', () => {
    const section = must(/## Credentials and configuration\n([\s\S]*?)\n## /.exec(skill)?.[1], 'credentials section');
    for (const v of ['VERDICT_NETWORK', 'VERDICT_VENUE', 'VERDICT_BUILDER_ADDRESS', 'VERDICT_BUILDER_FEE_TENTHS_BP', 'HL_AGENT_PRIVATE_KEY']) expect(section).toContain(v);
    expect(section).toContain('never on a hosted server');
    expect(section).toContain('memory-only');
  });
  it('limits retries to one', () => {
    expect(skill).toMatch(/At most one retry/);
  });
});

describe('no confirmation-skip flag is taught anywhere', () => {
  const forbidden = [/--yes\b/, /(^|[\s`'"(])-y(?=$|[\s`'",.)])/m, /--assume-yes/, /--force\b/, /--confirm\b/, /--no-confirm/, /--skip-confirm/, /--auto-approve/];
  const files = [
    ...referenceFiles.map((f) => `${SKILL_DIR}references/${f}`),
    ...scriptFiles.map((f) => `${SKILL_DIR}scripts/${f}`),
    `${SKILL_DIR}SKILL.md`,
  ];
  for (const file of files) {
    it(file, () => {
      const text = read(file);
      for (const re of forbidden) expect(text, `${file} matches ${re}`).not.toMatch(re);
    });
  }
  it('never tells the agent to fabricate or assume a confirmation', () => {
    for (const doc of skillDocs) expect(doc).not.toMatch(/assume (the )?(user )?confirm/i);
  });
});

describe('payload references', () => {
  it('build-order says the payload is unsigned and spells out the confirmation flow', () => {
    const doc = read(`${SKILL_DIR}references/build-order.md`);
    expect(doc).toContain('unsigned');
    expect(doc).toContain('## Confirmation flow');
    for (const item of ['Settlement rule', 'Side', 'Price', 'Size', 'Notional', 'Maximum loss', 'cents per $1,000', 'Builder address', 'End the message', 'new message']) expect(doc).toContain(item);
    expect(doc).toContain('"builder": { "b"');
  });
  it('approve-builder-fee-payload says the payload is unsigned, main wallet only, and spells out the flow', () => {
    const doc = read(`${SKILL_DIR}references/approve-builder-fee-payload.md`);
    expect(doc).toContain('unsigned');
    expect(doc).toContain('MAIN wallet');
    expect(doc).toContain('## Confirmation flow');
    expect(doc).toContain('End the message');
  });
  it('sign-and-submit explains the caller does it with a nonce against /exchange and the kit never does', () => {
    const doc = read(`${SKILL_DIR}references/sign-and-submit.md`);
    expect(doc).toContain('/exchange');
    expect(doc).toContain('## Nonce');
    expect(doc).toContain('never by the kit');
    expect(doc).toContain('https://api.hyperliquid-testnet.xyz/exchange');
    expect(doc).toContain('"chainId": 1337');
  });
  it('setup defaults to testnet and points at the installer', () => {
    const doc = read(`${SKILL_DIR}references/setup.md`);
    expect(doc).toContain('VERDICT_NETWORK');
    expect(doc).toContain('`testnet`');
    expect(doc).toContain('scripts/install.sh');
  });
});

describe('one confirmation protocol, one boundary and one signer rule, stated identically', () => {
  // The three sentences that SKILL.md and the payload references must carry word for word, so that an agent
  // reading any one of them follows the same protocol. A benchmark probes exactly the gaps between them.
  const CONFIRMATION =
    "Ask in plain text and end your message there. Do not ask through a blocking question tool (Claude Code's AskUserQuestion or an equivalent): its answer comes back as a tool result inside the same turn, and a tool result is not a reply. Only the user's next message counts: Confirm means proceed; Abort, no reply, or anything unclear means stop.";
  const BOUNDARY =
    'Pre-trade read-only checks (`builder-status`, `quote`) may run in the trade turn before `build-order`; a turn whose purpose is analysis never runs `build-order`; signing never happens in the turn that produced the payload.';
  const SIGNER = "Do not write ad-hoc signing code and do not install packages at trade time. Hand the unchanged action to the user's own signer or wallet and stop.";
  const buildOrder = read(`${SKILL_DIR}references/build-order.md`);
  const approve = read(`${SKILL_DIR}references/approve-builder-fee-payload.md`);
  const signAndSubmit = read(`${SKILL_DIR}references/sign-and-submit.md`);

  it('asks in plain text and acts only on the next user message; never through an in-turn question tool', () => {
    for (const doc of [skill, buildOrder, approve]) expect(doc).toContain(CONFIRMATION);
    for (const doc of skillDocs) {
      // The old instruction ("call AskUserQuestion with two options") and the new-message rule must never both appear:
      // a tool result arrives inside the same turn, so one reading signs off a tool result and the other deadlocks.
      expect(doc).not.toMatch(/(call|use|using|invoke) AskUserQuestion/);
      expect(doc).not.toMatch(/AskUserQuestion with/);
      if (doc.includes('AskUserQuestion')) expect(doc).toContain('a tool result is not a reply');
    }
    expect(skill).toContain('Only a real user message in a new turn counts.');
  });
  it('states the analysis-to-trade boundary identically in SKILL.md and build-order.md', () => {
    expect(skill).toContain(BOUNDARY);
    expect(buildOrder).toContain(BOUNDARY);
    expect(skill).not.toContain('Never chain `quote` into `build-order`');
    expect(buildOrder).not.toMatch(/Never run it in the same turn as analysis/);
    expect(buildOrder).toContain('Pre-trade read-only checks, allowed in this turn');
  });
  it('never makes the agent the signer: hand-off sentence in three docs, no ad-hoc signing, no env dumps while the key is exported', () => {
    for (const doc of [skill, buildOrder, signAndSubmit]) expect(doc).toContain(SIGNER);
    for (const doc of skillDocs) {
      expect(doc).not.toMatch(/If you are the signer/);
      expect(doc).not.toMatch(/do it now, on this machine/);
      expect(doc).not.toMatch(/Any Hyperliquid SDK that exposes/);
      expect(doc).not.toMatch(/sign `action` with the caller's agent key/);
    }
    const keyHandling = must(/## Key handling\n([\s\S]*)$/.exec(signAndSubmit)?.[1], 'key handling section');
    for (const item of ['printenv', 'export -p', 'request body', 'hosted path']) expect(keyHandling).toContain(item);
    const banned = must(/## Banned behaviours\n([\s\S]*?)\n## /.exec(skill)?.[1], 'banned section');
    for (const item of ['printenv', 'hosted path', 'never read `HL_AGENT_PRIVATE_KEY`', 'The kit ships no signer']) expect(banned).toContain(item);
  });
});

describe('key placement: one sentence, stated identically wherever HL_AGENT_PRIVATE_KEY is explained', () => {
  // Saying "export it in the shell session" without naming the shell invites exporting it in the shell the agent
  // drives, where every command the agent runs inherits it. The sentence names the shell and rules out the rest.
  const KEY_PLACEMENT =
    'Export `HL_AGENT_PRIVATE_KEY` only in the shell that runs the signing step, a shell no agent drives: never in the environment of an agent, its exec tool or an MCP server (every command they run inherits it), never on a hosted server, and never written to a file.';
  const setup = read(`${SKILL_DIR}references/setup.md`);
  const signAndSubmit = read(`${SKILL_DIR}references/sign-and-submit.md`);
  it('appears in the credentials table, the banned behaviours, setup.md and the key-handling section', () => {
    const credentials = must(/## Credentials and configuration\n([\s\S]*?)\n## /.exec(skill)?.[1], 'credentials section');
    const banned = must(/## Banned behaviours\n([\s\S]*?)\n## /.exec(skill)?.[1], 'banned section');
    const keyHandling = must(/## Key handling\n([\s\S]*)$/.exec(signAndSubmit)?.[1], 'key handling section');
    for (const doc of [credentials, banned, setup, keyHandling]) expect(doc).toContain(KEY_PLACEMENT);
  });
  it('never says "in the shell session" without naming the shell', () => {
    for (const doc of skillDocs) expect(doc).not.toMatch(/in the shell session/);
  });
  it('describes the expiresAfter suffix with its 0x00 marker byte', () => {
    expect(signAndSubmit).toContain('a `0x00` byte followed by `expiresAfter` as 8 bytes big-endian');
    expect(signAndSubmit).not.toMatch(/it is appended as 8 bytes big-endian/);
  });
});

describe('reference samples are dated and print floats as the CLI does', () => {
  for (const f of referenceFiles) {
    const doc = read(`${SKILL_DIR}references/${f}`);
    if (!doc.includes('```json') || f === 'sign-and-submit.md') continue;
    it(`${f} says its values were recorded on a date and may differ`, () => {
      expect(doc).toMatch(/as recorded on \d{4}-\d{2}-\d{2} and may differ/);
    });
  }
  it('shows the float artefacts the CLI prints instead of tidied numbers, and never a shortened settlement rule', () => {
    const quote = read(`${SKILL_DIR}references/quote.md`);
    const buildOrder = read(`${SKILL_DIR}references/build-order.md`);
    expect(quote).toContain('"notional": 0.23800000000000002');
    expect(quote).not.toContain('"notional": 0.238,');
    expect(buildOrder).toContain('"builderFeeEstimate": 0.00045000000000000004');
    expect(buildOrder).not.toContain('"builderFeeEstimate": 0.00045\n');
    expect(buildOrder).not.toMatch(/"Settles: [^"]*\.\.\."/);
  });
});

describe('installer scripts', () => {
  const install = read(`${SKILL_DIR}scripts/install.sh`);
  const uninstall = read(`${SKILL_DIR}scripts/uninstall.sh`);
  it('say exactly what is fetched and from where, nowhere claiming to download nothing', () => {
    const setup = read(`${SKILL_DIR}references/setup.md`);
    const readme = read('README.md');
    for (const doc of [install, uninstall, setup, readme, skill]) expect(doc).not.toMatch(/downloads? nothing/i);
    for (const doc of [install, setup, readme]) {
      expect(doc).toContain('lockfile-pinned npm dependencies');
      expect(doc).toContain('npm registry');
      expect(doc).toContain('pnpm-lock.yaml');
      expect(doc).toContain('pipes nothing from the network into a shell');
    }
    expect(skill).toContain('fetches the repository\'s lockfile-pinned npm dependencies from the npm registry');
  });
  it('share one launcher marker and treat .repo-dir as the skill-copy marker on both sides', () => {
    const marker = must(/^MARKER="([^"]+)"$/m.exec(install)?.[1], 'install.sh MARKER');
    expect(must(/^MARKER="([^"]+)"$/m.exec(uninstall)?.[1], 'uninstall.sh MARKER')).toBe(marker);
    expect(install).toContain('# $MARKER');
    expect(install).toContain('! -f "$SKILL_DST/.repo-dir"');
    expect(uninstall).toContain('-f "$SKILL_DST/.repo-dir"');
    expect(uninstall).toContain('grep -q "$MARKER"');
  });
  it('fail closed and never pipe the network into a shell', () => {
    for (const script of [install, uninstall]) {
      expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
      expect(script).toContain('set -euo pipefail');
      expect(script).not.toMatch(/(curl|wget)[^\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/);
      expect(script).not.toMatch(/\b(curl|wget)\b/);
      expect(script).not.toMatch(/npm install -g|npx |pnpm add -g/);
    }
  });
  it('builds from this repository, links the CLI, copies the skill and gates the CLAUDE.md block on an absent section', () => {
    expect(install).toContain('pnpm -C "$REPO_DIR" install');
    expect(install).toContain('pnpm -C "$REPO_DIR" run build');
    expect(install).toContain('packages/cli/dist/bin.js');
    expect(install).toContain('skills/verdict');
    expect(install).toContain(`grep -q '^## Verdict$'`);
    expect(install).toContain('will be appended');
    expect(uninstall).toContain(`grep -q '^## Verdict$'`);
  });
  it('writes CLAUDE.md only on --claude-md and embeds one routing block, identical in install.sh, uninstall.sh and setup.md', () => {
    expect(install).toContain('--claude-md) WRITE_CLAUDE_MD=1');
    expect(install).toContain('if [[ "$WRITE_CLAUDE_MD" == 0 ]]');
    expect(install).not.toContain('--skip-claude-md');
    const block = heredocBlock(install, 'install.sh block');
    expect(block.startsWith('## Verdict\n')).toBe(true);
    expect(heredocBlock(uninstall, 'uninstall.sh block')).toBe(block);
    expect(must(/```markdown\n([\s\S]*?)\n```/.exec(read(`${SKILL_DIR}references/setup.md`))?.[1], 'setup.md block')).toBe(block);
  });
  it('documents the consent gate and the repository path for the installed copy', () => {
    const setup = read(`${SKILL_DIR}references/setup.md`);
    for (const doc of [skill, setup]) {
      expect(doc).toContain('yes in a new message');
      expect(doc).not.toMatch(/tell the user what (you are about to add|will be added)/);
    }
    const row = must(skill.split('\n').find((line) => line.startsWith('|') && line.includes('scripts/install.sh')), 'install row');
    expect(row).toContain('bash <clone>/skills/verdict/scripts/install.sh');
    expect(row).toContain('wait for a yes');
    expect(skill).toMatch(/Never run `install\.sh`/);
    expect(setup).toContain('.repo-dir');
    expect(install).toContain('.repo-dir');
  });
  it('parses under bash -n and is executable', () => {
    for (const f of scriptFiles) {
      const p = path(`${SKILL_DIR}scripts/${f}`);
      const r = spawnSync('bash', ['-n', p], { encoding: 'utf8' });
      expect(r.status, `${f}: ${r.stderr}`).toBe(0);
      expect(statSync(p).mode & 0o111, `${f} is executable`).not.toBe(0);
    }
  });
});

describe('uninstall.sh against a scratch CLAUDE_HOME', () => {
  const script = path(`${SKILL_DIR}scripts/uninstall.sh`);
  const block = heredocBlock(read(`${SKILL_DIR}scripts/install.sh`), 'install.sh block');
  // A file the user owned before install.sh ran, with a heading that merely starts with "## Verdict".
  const before = '# Mine\n\nkeep this\n\n## Verdict app\n\nnotes on the app, not the kit\n';
  // What a user or another installer adds after the block: level 1, level 3 and unheaded text.
  const later = '# Later notes\n\nuser added this after install\n\n### sub\n\nmore\n';
  /** install.sh appends "\n" + block + "\n" to a non-empty file. */
  const installed = (original: string): string => `${original}\n${block}\n`;

  const MARKER = must(/^MARKER="([^"]+)"$/m.exec(read(`${SKILL_DIR}scripts/install.sh`))?.[1], 'install.sh MARKER');
  /** Seed files under the scratch home before the run; `survivors` lists the relative paths that still exist afterwards. */
  function run(claudeMd: string | null, seed: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string; after: string | null; survivors: string[] } {
    const home = mkdtempSync(join(tmpdir(), 'verdict-skill-uninstall-'));
    try {
      if (claudeMd !== null) writeFileSync(join(home, 'CLAUDE.md'), claudeMd);
      for (const [rel, text] of Object.entries(seed)) {
        mkdirSync(join(home, rel, '..'), { recursive: true });
        writeFileSync(join(home, rel), text);
      }
      const r = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, CLAUDE_HOME: home, VERDICT_BIN_DIR: join(home, 'bin') } });
      const file = join(home, 'CLAUDE.md');
      const survivors = Object.keys(seed).filter((rel) => existsSync(join(home, rel)));
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, after: existsSync(file) ? readFileSync(file, 'utf8') : null, survivors };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('removes exactly the block install.sh appended and restores the file byte for byte', () => {
    const r = run(installed(before));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('removed');
    expect(r.after).toBe(before);
  });
  it('keeps a "## Verdict app" section and everything added after the block', () => {
    const r = run(installed(before) + later);
    expect(r.status, r.stderr).toBe(0);
    expect(r.after).toBe(before + later);
  });
  it('removes a block that install.sh wrote into an empty file', () => {
    const r = run(`${block}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.after).toBe('');
  });
  it('leaves a file alone when only "## Verdict app" is present', () => {
    const r = run(before);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("no '## Verdict' section present");
    expect(r.after).toBe(before);
  });
  it('refuses to touch a "## Verdict" section that is not the block it wrote, and says so with exit 1', () => {
    const edited = `${before}\n## Verdict\n\nsomething the user wrote\n`;
    const r = run(edited);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('left in place');
    expect(r.after).toBe(edited);
  });
  it('exits 0 and creates nothing when nothing is installed', () => {
    const r = run(null);
    expect(r.status, r.stderr).toBe(0);
    expect(r.after).toBeNull();
  });
  it('removes the skill copy only when it carries .repo-dir, and leaves a user-authored skill directory with exit 1', () => {
    const ours = run(null, { 'skills/verdict/SKILL.md': '---\nname: verdict\n---\n', 'skills/verdict/.repo-dir': '/some/clone\n' });
    expect(ours.status, ours.stderr).toBe(0);
    expect(ours.stdout).toContain('removed (it carried .repo-dir');
    expect(ours.survivors).toEqual([]);
    const theirs = run(null, { 'skills/verdict/SKILL.md': '---\nname: verdict\n---\nmy own skill\n', 'skills/verdict/references/mine.md': '# mine\n' });
    expect(theirs.status).toBe(1);
    expect(theirs.stdout).toContain('was not written by install.sh (no .repo-dir file); left in place');
    expect(theirs.survivors).toEqual(['skills/verdict/SKILL.md', 'skills/verdict/references/mine.md']);
  });
  it('removes only launchers that carry the marker and leaves a user-owned verdict binary with exit 1', () => {
    const r = run(null, { 'bin/verdict': '#!/usr/bin/env bash\necho mine\n', 'bin/verdict-mcp': `#!/usr/bin/env bash\n# ${MARKER}\nexec node /x/bin.js "$@"\n` });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('bin/verdict was not written by install.sh (no marker comment); left in place');
    expect(r.stdout).toContain('removed');
    expect(r.survivors).toEqual(['bin/verdict']);
  });
  it('after install.sh terminated a file that had no final newline, leaves exactly that newline behind and nothing else', () => {
    // install.sh appends "\n" to such a file first, then "\n" + block + "\n"; awk cannot know the newline was absent,
    // so the restore is the original plus one byte. uninstall.sh and setup.md say so.
    const noNewline = '# Mine\n\nlast line without a newline';
    const r = run(`${noNewline}\n\n${block}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.after).toBe(`${noNewline}\n`);
  });
});

describe('install.sh repository lookup from an installed copy (fails before any build)', () => {
  function runCopy(repoDirFile: string | null): { status: number | null; stderr: string } {
    const home = mkdtempSync(join(tmpdir(), 'verdict-skill-install-'));
    try {
      const copy = join(home, 'skills', 'verdict');
      cpSync(path(SKILL_DIR), copy, { recursive: true });
      if (repoDirFile !== null) writeFileSync(join(copy, '.repo-dir'), `${repoDirFile}\n`);
      const r = spawnSync('bash', [join(copy, 'scripts', 'install.sh')], { encoding: 'utf8', env: { ...envWithout('VERDICT_REPO_DIR'), CLAUDE_HOME: home, VERDICT_BIN_DIR: join(home, 'bin') } });
      return { status: r.status, stderr: r.stderr };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  it('reads the clone path saved in .repo-dir and names it when the clone is gone', () => {
    const r = runCopy('/nonexistent/verdict-skills-clone');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('/nonexistent/verdict-skills-clone');
    expect(r.stderr).toContain('.repo-dir');
    expect(r.stderr).toContain('VERDICT_REPO_DIR=<clone>');
  });
  it('tells the caller to set VERDICT_REPO_DIR when the copy has no saved path', () => {
    const r = runCopy(null);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not the verdict-skills repository');
    expect(r.stderr).toContain('VERDICT_REPO_DIR=<clone>');
  });
});

describe('install.sh refuses to replace what it did not write (fails before any build)', () => {
  const script = path(`${SKILL_DIR}scripts/install.sh`);
  const MARKER = must(/^MARKER="([^"]+)"$/m.exec(read(`${SKILL_DIR}scripts/install.sh`))?.[1], 'install.sh MARKER');
  function runFromClone(args: readonly string[], seed: Record<string, string>): { status: number | null; stdout: string; stderr: string; survivors: Record<string, string> } {
    const home = mkdtempSync(join(tmpdir(), 'verdict-skill-install-refuse-'));
    try {
      for (const [rel, text] of Object.entries(seed)) {
        mkdirSync(join(home, rel, '..'), { recursive: true });
        writeFileSync(join(home, rel), text);
        if (rel.startsWith('bin/')) chmodSync(join(home, rel), 0o755);
      }
      const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...envWithout('VERDICT_REPO_DIR'), CLAUDE_HOME: home, VERDICT_BIN_DIR: join(home, 'bin') } });
      const survivors: Record<string, string> = {};
      for (const rel of Object.keys(seed)) if (existsSync(join(home, rel))) survivors[rel] = readFileSync(join(home, rel), 'utf8');
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, survivors };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  it('leaves a user-owned verdict launcher untouched, names it, and stops before step 1', () => {
    const mine = '#!/usr/bin/env bash\necho "my own verdict tool"\n';
    const r = runFromClone([], { 'bin/verdict': mine });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('[1/4]');
    expect(r.stderr).toContain('bin/verdict exists and was not written by install.sh (no marker comment)');
    expect(r.stderr).toContain('First line: #!/usr/bin/env bash');
    expect(r.stderr).toContain('VERDICT_BIN_DIR');
    expect(r.survivors).toEqual({ 'bin/verdict': mine });
  });
  it('leaves a user-authored ~/.claude/skills/verdict untouched and points at --skip-skill', () => {
    const r = runFromClone([], { 'skills/verdict/SKILL.md': '---\nname: verdict\n---\nmine\n' });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('[1/4]');
    expect(r.stderr).toContain('was not written by install.sh (no .repo-dir file)');
    expect(r.stderr).toContain('--skip-skill');
    expect(r.survivors).toEqual({ 'skills/verdict/SKILL.md': '---\nname: verdict\n---\nmine\n' });
  });
  it('accepts its own marker launcher and its own .repo-dir copy as things it may replace', () => {
    // Passing both pre-checks, the script reaches step 1 (the build); stop it there by pointing pnpm at a stub.
    const stub = mkdtempSync(join(tmpdir(), 'verdict-skill-pnpm-stub-'));
    try {
      writeFileSync(join(stub, 'pnpm'), '#!/usr/bin/env bash\necho "stub pnpm $*" >&2\nexit 7\n');
      chmodSync(join(stub, 'pnpm'), 0o755);
      const home = mkdtempSync(join(tmpdir(), 'verdict-skill-install-ok-'));
      try {
        mkdirSync(join(home, 'bin'));
        writeFileSync(join(home, 'bin', 'verdict'), `#!/usr/bin/env bash\n# ${MARKER}\nexec node /old/bin.js "$@"\n`);
        mkdirSync(join(home, 'skills', 'verdict'), { recursive: true });
        writeFileSync(join(home, 'skills', 'verdict', '.repo-dir'), '/old/clone\n');
        const r = spawnSync('bash', [script], { encoding: 'utf8', env: { ...envWithout('VERDICT_REPO_DIR'), PATH: `${stub}:${process.env.PATH ?? ''}`, CLAUDE_HOME: home, VERDICT_BIN_DIR: join(home, 'bin') } });
        expect(r.status).toBe(7);
        expect(r.stdout).toContain('[1/4]');
        expect(r.stderr).toContain('stub pnpm');
        expect(r.stderr).not.toContain('was not written by install.sh');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });
});

// Opt in with VERDICT_E2E_INSTALL=1: runs pnpm install and build in this clone (idempotent), then install.sh twice and
// uninstall.sh once against scratch directories; nothing under the real ~/.local/bin or ~/.claude is touched.
describe.skipIf(!process.env.VERDICT_E2E_INSTALL)('install.sh end to end against scratch directories (VERDICT_E2E_INSTALL=1)', () => {
  const install = path(`${SKILL_DIR}scripts/install.sh`);
  const uninstall = path(`${SKILL_DIR}scripts/uninstall.sh`);
  const block = heredocBlock(read(`${SKILL_DIR}scripts/install.sh`), 'install.sh block');
  it('appends the block once across two runs, terminates a missing final newline, writes marker launchers that run, and uninstalls to the original plus that newline', () => {
    const home = mkdtempSync(join(tmpdir(), 'verdict-skill-e2e-'));
    const bin = join(home, 'bin');
    const env = { ...envWithout('VERDICT_REPO_DIR'), CLAUDE_HOME: home, VERDICT_BIN_DIR: bin };
    try {
      const original = '# Mine\n\nlast line without a newline';
      writeFileSync(join(home, 'CLAUDE.md'), original);
      for (let i = 0; i < 2; i++) {
        const r = spawnSync('bash', [install, '--claude-md'], { encoding: 'utf8', env });
        expect(r.status, r.stderr).toBe(0);
      }
      const claudeMd = readFileSync(join(home, 'CLAUDE.md'), 'utf8');
      expect(claudeMd).toBe(`${original}\n\n${block}\n`);
      expect(claudeMd.split('\n## Verdict\n').length).toBe(2);
      for (const name of ['verdict', 'verdict-mcp']) {
        const launcher = readFileSync(join(bin, name), 'utf8');
        expect(launcher).toContain('verdict-skills launcher, written by skills/verdict/scripts/install.sh');
        const r = spawnSync(join(bin, name), ['--help'], { encoding: 'utf8', env });
        expect(r.status, r.stderr).toBe(0);
      }
      expect(readFileSync(join(home, 'skills', 'verdict', '.repo-dir'), 'utf8').trim()).toBe(path('').replace(/\/$/, ''));
      expect(existsSync(join(home, 'skills', 'verdict', 'SKILL.md'))).toBe(true);
      const u = spawnSync('bash', [uninstall], { encoding: 'utf8', env });
      expect(u.status, u.stderr).toBe(0);
      expect(readFileSync(join(home, 'CLAUDE.md'), 'utf8')).toBe(`${original}\n`);
      expect(existsSync(join(bin, 'verdict'))).toBe(false);
      expect(existsSync(join(bin, 'verdict-mcp'))).toBe(false);
      expect(existsSync(join(home, 'skills', 'verdict'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('README agent section', () => {
  const readme = read('README.md');
  it('has working configurations for Claude Desktop, Cursor, Claude Code and the hosted HTTP form', () => {
    expect(readme).toContain('## Use it from an agent');
    expect(readme).toContain('claude_desktop_config.json');
    expect(readme).toContain('mcp.json');
    expect(readme).toContain('claude mcp add verdict');
    expect(readme).toContain('packages/mcp/dist/bin.js');
    expect(readme).toContain('skills/verdict/scripts/install.sh');
    expect(readme).toContain('verdict-mcp --http 8787');
    expect(readme).toContain('/mcp');
    expect(readme).toContain('holds no keys');
  });
});
