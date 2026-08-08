# CLAUDE.md - tasker-effect

## Project Overview

TypeScript library for writing Tasker (Android automation app) profiles and tasks in TypeScript, compiled to JavaScript that Tasker executes directly.

**Key insight:** Tasker can execute JavaScript/JavaScriptlet actions natively. We write TypeScript → compile to JS → Tasker runs the JS directly. No XML conversion needed.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript 7.0
- **Core**: Effect 4.0 (beta)
- **Target**: Tasker's JavaScript execution environment

## Architecture

```
src/
├── index.ts          # Main exports
├── tasker-api.ts     # Type-safe bindings for Tasker's JavaScript API
├── profile.ts        # Task/Profile definitions using Effect Schema
├── sync.ts           # Pull compiled JS from CI artifacts
└── runtime.ts        # Runtime helpers for execution in Tasker
```

## Key Requirements

### 1. Tasker API Bindings (`tasker-api.ts`)
Create type-safe wrappers for ALL Tasker JavaScript functions:
- Reference: https://tasker.joaoapps.com/userguide/en/javascript.html
- Functions: `flash()`, `performTask()`, `setGlobal()`, `global()`, `setLocal()`, `local()`, `setWallpaper()`, `browseURL()`, `mediaControl()`, `say()`, `shell()`, etc.
- Include ALL functions from the documentation
- Use Effect services for testability

### 2. Task DSL (`profile.ts`)
Effect-based DSL for defining Tasker tasks as TypeScript:
- Use Effect Schema for validation
- Tasks are sequences of actions
- Actions map to Tasker JS API calls
- Should compile to clean JS that Tasker understands

Example target API:
```typescript
const morningRoutine = Task.make({
  name: "Morning Routine",
  actions: [
    Action.flash({ text: "Good morning!" }),
    Action.setVolume({ stream: "media", level: 50 }),
    Action.say({ text: "Time to wake up" }),
  ],
});

// Compiles to JS that Tasker can execute
const js = compileTask(morningRoutine);
```

### 3. Sync Module (`sync.ts`)
Pull latest compiled JS profiles from GitHub CI:
- Fetch artifacts from GitHub Actions (use gh CLI or GitHub API)
- Download and apply to device
- Must work when called FROM Tasker's JavaScript environment
- Simple HTTP fetch to grab latest release/artifact

### 4. Compiler/Bundler
Compile TypeScript tasks to standalone JS files:
- Output should be single-file JS that Tasker can execute
- Include only the runtime helpers needed
- Strip types, bundle dependencies
- CI produces these artifacts

## Effect Patterns

Follow Effect 4 best practices:
- Use `Effect.Service` for dependency injection
- Use `Schema.TaggedError` for typed errors
- Use `Layer` composition for configuration
- Prefer `yield*` over `.pipe()` for readability
- Use `Schema.TaggedClass` for domain types

## CI/CD (`.github/workflows/ci.yml`)

GitHub Actions should:
1. Type check (`bun run typecheck`)
2. Run tests (`bun test`)
3. Build/compile tasks to JS
4. Upload compiled JS as artifacts
5. On release: publish artifacts that devices can pull

## Development Commands

```bash
bun install          # Install deps
bun run typecheck    # Type check
bun test             # Run tests
bun run build        # Compile to dist/
bun run compile      # Compile tasks to Tasker-ready JS
```

## What NOT to do

- ❌ Do NOT compile to XML - Tasker runs JS directly
- ❌ Do NOT try to create `.tsk.xml` files
- ❌ Do NOT overcomplicate - Tasker just needs valid JS files

## Existing Code

There may be existing code from a previous attempt that compiled to XML. Ignore it or remove it. Focus on the JS-based approach described above.
