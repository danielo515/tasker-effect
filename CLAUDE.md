# CLAUDE.md - tasker-effect

## Project Overview

TypeScript library for writing Tasker (Android automation app) tasks in TypeScript, compiled to JavaScript that Tasker executes directly.

**Key insight:** Tasker runs JavaScript natively (JavaScript/JavaScriptlet actions). We never generate XML. TypeScript → JS → the device pulls the latest build and runs it.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript 7.0
- **Core**: Effect 3.22 — Effect 4 beta was tried and reverted (breaking API churn between betas); we write "Effect 4 style" (`Effect.Service`, `Schema.TaggedError`, Layers) so a future migration is mechanical. Do not re-introduce the 4.x beta without being asked.
- **Target**: Tasker's JavaScript execution environment (WebView; sync XHR available, no Node APIs)

## Architecture

```
src/
├── index.ts          # Public exports
├── tasker-api.ts     # Effect bindings for all ~110 Tasker JS functions + `raw` escape hatch
├── profile.ts        # DSL: Schema.TaggedClass actions/triggers, Task/Profile/Project classes
├── compiler.ts       # DSL → plain JS codegen (no runtime deps in output)
├── runtime.ts        # runInTasker for Effect programs that run on-device
├── sync.ts           # Pull compiled JS from GitHub releases/artifacts (works on-device)
└── cli.ts            # `tasker-effect compile` for consumer repos
tasks/
├── automations.ts    # DSL definitions compiled by CI
└── scripts/*.ts      # Effect programs, each bundled to a single JS file
scripts/compile-tasks.ts  # bun run compile → dist-tasker/
bin/tasker-effect.mjs     # CLI entry (npm bin)
```

## Two compilation paths (keep them distinct)

1. **DSL codegen** (`compiler.ts`): tasks are *data*; `compileTaskToJs`/`compileProjectFiles` are pure functions emitting ~20-line dependency-free JS that only calls Tasker globals. Consumers use the CLI: `bunx tasker-effect compile [entry] [--out dir]`. No bundler involved.
2. **Effect programs** (`tasks/scripts/`): full TS + Effect, bundled per-entrypoint to a single IIFE file with Bun.build (≈350 KB min — the Effect core is not further tree-shakeable). Bundling for *consumer* repos is intentionally NOT the library's job; they use their own bundler (e.g. `esbuild script.ts --bundle --minify --format=iife --platform=browser`). Do not add bundling to the CLI.

## Distribution / device sync

- CI (`.github/workflows/ci.yml`): typecheck + test → `bun run compile` → uploads `dist-tasker/` as the `tasker-js` artifact → refreshes the rolling release `tasker-js-latest`.
- On-device, `sync-profiles.js` (a bundled script from `tasks/scripts/`) downloads the newest release assets to `/sdcard/Tasker/js/` via Tasker's own `writeFile`. Tasker reads JS files from disk on every action run, so overwriting a file updates behavior on the next trigger — including sync-profiles.js itself.
- Tasker profiles/triggers cannot be created from JS: new tasks need a one-time manual pairing in the Tasker UI (trigger + JavaScript action → file path). The compiler emits a README describing the triggers to configure.

## Effect Patterns

- `Effect.Service` for services (`Tasker`, `TaskerCompiler`, `ProfileSync`, `FileStore`, …)
- `Schema.TaggedError` for every error; handle with `Effect.catchTag`/`catchTags`
- `Schema.TaggedClass` for DSL actions/triggers; validation happens at construction
- `Layer` composition to swap Node vs on-device implementations (`TaskerFileStore`, `TaskerProfileSyncLive`)
- `Effect.runPromise` only at edges (scripts, CLI, runtime entry)
- Tests provide the recording test layer from `makeTaskerTestLayer` — no device needed

## Development Commands

```bash
bun install          # Install deps
bun run typecheck    # Type check (src/ only)
bun test             # Run tests
bun run build        # Compile library to dist/ (npm publish surface)
bun run compile      # Compile tasks/ to dist-tasker/ (Tasker-ready JS)
```

## What NOT to do

- ❌ No XML. Tasker runs JS directly; never generate `.tsk.xml`/`.prf.xml`
- ❌ No bundling in the CLI — consumers bring their own bundler
- ❌ No Node APIs in code that runs on-device (`compiler.ts` output, `tasks/scripts/`)
- ❌ Don't upgrade to Effect 4 beta unless explicitly requested
