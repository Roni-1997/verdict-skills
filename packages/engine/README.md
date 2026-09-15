# @verdict/engine

The Verdict app's cross-venue research engine (`research-core.ts`, `playbooks.ts`, `hl-shape.ts` from `Roni-1997/verdict`), byte for byte at the commit recorded in `UPSTREAM.json`, compiled for Node. No engine code is written in this package: the kit's `pnpm run check` recomputes the recorded hashes and compares every file with the copy GitHub serves at the pinned commit, and fails on any difference.

Not published yet. It is a dependency of `@verdict/core`, which wraps it with a validating fetch and typed snapshot adapters; use `@verdict/core` (or `@verdict/cli` and `@verdict/mcp`) rather than this package directly. Once published:

```sh
pnpm add @verdict/engine
```

Documentation, rules and the pin procedure: https://github.com/Roni-1997/verdict-skills#the-engine
