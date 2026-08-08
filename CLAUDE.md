# CLAUDE.md - tasker-effect

## Project Overview

TypeScript library for managing Tasker (Android automation app) profiles using Effect 4.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript 7.0
- **Core**: Effect 4.0 (beta)
- **Target**: Tasker's JavaScript execution environment + Node.js for development

## Architecture

```
src/
├── index.ts          # Main exports
├── tasker-api.ts     # Type-safe bindings for Tasker's JavaScript API
├── profile.ts        # Profile and Task definitions using Effect Schema
├── sync.ts           # Pull/push profiles from CI artifacts
└── compiler.ts       # Compile TypeScript profiles to Tasker-compatible JS
```

## Key Requirements

1. **Tasker API Bindings**: Create type-safe wrappers for all Tasker JavaScript functions
   - Reference: https://tasker.joaoapps.com/userguide/en/javascript.html
   - Functions like `flash()`, `setWallpaper()`, `performTask()`, etc.

2. **Profile DSL**: Effect-based DSL for defining Tasker profiles
   - Use Effect Schema for validation
   - Support all trigger types (time, location, event, state, etc.)
   - Support all action types

3. **Sync Module**: Pull latest compiled profiles from GitHub CI
   - Fetch artifacts from GitHub Actions
   - Apply to device (via Tasker's file import)
   - Must work when called from Tasker's JavaScript environment

4. **Compiler**: Transform TypeScript profiles to Tasker-importable format
   - Output should be `.tsk.xml` or Tasker JSON format
   - Run in CI to produce artifacts

## Effect Patterns

Follow Effect 4 patterns:
- Use `Effect.Service` for dependency injection
- Use `Schema.TaggedError` for typed errors
- Use `Layer` composition for configuration
- Prefer `yield*` over `.pipe()` for readability

## CI/CD

GitHub Actions should:
1. Type check
2. Run tests
3. Build/compile profiles
4. Upload compiled profiles as artifacts
5. (Optional) Deploy to a releases endpoint that devices can pull from

## Development Commands

```bash
bun install          # Install deps
bun run typecheck    # Type check
bun test             # Run tests
bun run build        # Compile to dist/
```
