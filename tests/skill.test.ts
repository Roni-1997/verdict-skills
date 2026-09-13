// The skill face is documentation, so its tests check structure and safety text: every CLI command in
// USAGE has a table row and a reference file, the required sections exist, no confirmation-skip flag is
// taught anywhere, the unsigned nature of the payloads is stated, and the installer is a plain shell
// script that builds from this repository and pipes nothing from the network into a shell.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
  it('reads eight commands out of USAGE', () => {
    expect(usageCommands).toEqual(['markets', 'market', 'book', 'quote', 'positions', 'builder-status', 'approve-builder-fee-payload', 'build-order']);
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
    for (const cmd of ['markets', 'market', 'book', 'quote', 'positions', 'builder-status']) expect(section).toContain(`\`${cmd}\``);
    expect(section).not.toContain('build-order');
    expect(section).not.toContain('approve-builder-fee-payload');
  });
  it('resolves every {baseDir} path it mentions to a file in the skill directory', () => {
    const refs = new Set([...skill.matchAll(/\{baseDir\}\/([\w./-]+)/g)].map((m) => must(m[1], 'baseDir path')));
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

describe('installer scripts', () => {
  const install = read(`${SKILL_DIR}scripts/install.sh`);
  const uninstall = read(`${SKILL_DIR}scripts/uninstall.sh`);
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
    expect(install).toMatch(/grep -q '\^## Verdict'/);
    expect(install).toContain('will be appended');
    expect(uninstall).toMatch(/\^## Verdict/);
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
