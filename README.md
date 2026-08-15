# tasker-effect

Write [Tasker](https://tasker.joaoapps.com/) (Android automation) tasks in
TypeScript with [Effect](https://effect.website/), and compile them to plain
JavaScript that Tasker executes directly.

**The approach:** Tasker can run JavaScript natively via its JavaScript /
JavaScriptlet actions. So there is no XML to generate — you write TypeScript,
CI compiles it to JS, and your device pulls the latest build and runs it.

```
TypeScript (DSL or Effect programs)
        │  bun run compile
        ▼
dist-tasker/*.js  ──►  GitHub CI artifact + rolling release
        │
        ▼  sync-profiles.js (runs on-device)
/sdcard/Tasker/js/*.js  ──►  Tasker JavaScript actions
```

## Modules

| Module | Purpose |
| --- | --- |
| `tasker-api` | Type-safe Effect bindings for every documented Tasker JS function (~110), plus a typed `raw` escape hatch |
| `profile` | Schema-validated DSL: tasks are sequences of tagged actions, profiles add trigger metadata |
| `compiler` | Compiles DSL definitions to standalone JS using only Tasker globals (no runtime deps) |
| `runtime` | `runInTasker` for Effect programs bundled to a single file |
| `sync` | Pulls the latest compiled JS from GitHub releases/artifacts — works on-device |

## Quick start

```bash
bun install
bun run typecheck   # type check
bun test            # run tests
bun run compile     # compile tasks/ to dist-tasker/
```

### Declarative DSL

```typescript
import { Action, Trigger, Task, Profile, cond } from "tasker-effect";

const lowBattery = new Profile({
  name: "Low Battery Saver",
  triggers: [Trigger.batteryLevel(0, 20)],
  enter: new Task({
    name: "Battery Saver On",
    actions: [
      Action.flash("Battery low — saving power"),
      Action.setWifi(false),
      Action.when(cond("%LOCATION", "eq", "home"), [
        Action.say("Charge me, please"),
      ]),
    ],
  }),
});
```

`bun run compile` turns each task into a plain JS file plus a README that
documents which triggers to configure in the Tasker UI. Everything is
validated at construction time by Effect Schema — invalid hours, empty
messages or malformed vibration patterns fail before anything reaches the
device.

### CLI

Repos that depend on `tasker-effect` can compile their DSL definitions
without writing any build script:

```bash
bunx tasker-effect compile                       # tasks/automations.ts → dist-tasker/
bunx tasker-effect compile my/entry.ts --out build
```

The CLI imports the entry module and compiles every export (default and
named) that is a `Project`, `Profile` or `Task` into Tasker-ready JS files,
plus a setup README per project. TypeScript entries require Bun (`bunx`);
plain JavaScript entries also work under Node (`npx tasker-effect`).

The CLI is DSL codegen only — bundling Effect programs for Tasker is
intentionally left to the consumer, e.g.:

```bash
esbuild script.ts --bundle --minify --format=iife --platform=browser --outfile=dist-tasker/script.js
```

### Effect programs on-device

Scripts in `tasks/scripts/` run the full Effect runtime inside Tasker; the
compile step bundles each one (with `effect` included) into a single file:

```typescript
import { Effect } from "effect";
import { Tasker, runInTasker } from "tasker-effect";

const program = Effect.gen(function* () {
  const tasker = yield* Tasker;
  const battery = yield* tasker.global("BATT");
  yield* tasker.flash(`Battery at ${battery}%`);
});

void runInTasker(program, { exitWhenDone: true });
```

In Tasker: create a task with a **JavaScript** action pointing at the bundled
file and disable *Auto Exit* (the script calls `exit()` itself).

The `Tasker` service is an `Effect.Service` — swap in the test layer to unit
test your automations off-device:

```typescript
import { makeTaskerTestLayer } from "tasker-effect";

const { layer, calls } = makeTaskerTestLayer({
  global: () => Effect.succeed("15"),
});
// run your program with `Effect.provide(layer)` and assert on `calls`
```

## Keeping devices up to date

CI compiles `tasks/` on every push, uploads the result as the `tasker-js`
artifact and refreshes a rolling GitHub release (`tasker-js-latest`).

On the device, run the bundled `sync-profiles.js` (itself produced by
`bun run compile`) from a Tasker task — e.g. triggered daily or by an NFC
tag. It downloads the newest release assets to `/sdcard/Tasker/js/` using
Tasker's own `writeFile`, so every JavaScript action that points there picks
up the new build on its next run. Point it at your fork with the Tasker
globals `%SYNC_OWNER` / `%SYNC_REPO`.

From Node/CI you can do the same programmatically:

```typescript
import { Effect } from "effect";
import { pullLatestProfiles } from "tasker-effect";

await Effect.runPromise(
  pullLatestProfiles({
    owner: "danielo515",
    repo: "tasker-effect",
    targetDir: "./synced",
  })
);
```

## Project layout

```
src/               # the library (published surface)
tasks/             # your automations, compiled by CI
  automations.ts   #   DSL project → one JS file per task
  scripts/         #   Effect programs → single-file bundles
scripts/           # build tooling (compile-tasks.ts)
examples/          # runnable walkthroughs
dist-tasker/       # compiled output (gitignored; CI artifact)
```

## Effect patterns used

- `Effect.Service` for `Tasker`, the compiler and the sync services
- `Schema.TaggedError` for every error (`TaskerCallError`, `CompileError`,
  `GitHubApiError`, …) — catch them with `Effect.catchTag`
- `Schema.TaggedClass` for DSL actions and triggers
- `Layer` composition to swap Node vs Tasker implementations of storage,
  HTTP and zip extraction (`TaskerFileStore`, `TaskerProfileSyncLive`)

## License

MIT
