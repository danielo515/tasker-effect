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
| `compiler` | Compiles DSL definitions to standalone JS using only Tasker globals (no runtime deps), plus a dispatcher and an import-once task XML |
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

### Typed task references

Calling another DSL task takes the `Task` *object*, not a string — typos
become type errors, and renames propagate automatically:

```typescript
const weatherCheck = new Task({ name: "Weather Check", actions: [/* … */] });

const morningEnter = new Task({
  name: "Morning Enter",
  actions: [
    Action.flash("Good morning!"),
    Action.performTask(weatherCheck),        // typed reference
    Action.enableProfile(nightMode, false),  // same for profiles
  ],
});
```

The action itself stays flat and serializable — only the task's name is
stored. At compile time `Action.performTask` routes through the shared
dispatcher: it emits `performTask("TE Dispatch", <priority>, "<name>",
undefined)`, so the call resolves against the dispatcher's name→file map.
Because the dispatcher consumes `%par1` (target name) and `%par2` (exit
switch) for its own resolution, this variant takes no custom parameters —
only `priority`.

**Escape hatch for UI-created tasks:** tasks and profiles that only exist
on the phone (hand-built in the Tasker UI) are referenced by name and
compile to a direct call, parameters included:

```typescript
Action.performTaskerTask("Hand Made Task", { parameterOne: "now" });
Action.enableTaskerProfile("Hand Made Profile", false);
```

These are not validated — the compiler cannot see what exists on-device.

**Linker check:** compiling a `Project` fails with a `CompileError` if any
DSL `performTask` references a task that is not in `project.tasks`, naming
the offending profile/task and listing the valid targets. Standalone
task/profile compilation has no project context, so the check only runs at
the project level.

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

### The dispatcher: import once, then only triggers

Compiling a `Project` also emits two extra files:

- **`tasker-effect.tsk.xml`** — static scaffolding containing a single
  shared task, **TE Dispatch**, whose only action is a file-based
  *JavaScript* action (Auto Exit on) pointing at
  `/sdcard/Tasker/js/dispatcher.js`. It never embeds compiled logic, so you
  import it exactly once: Tasker → Tasks tab → long-press → *Import Task*.
- **`dispatcher.js`** — generated from your project: it embeds a map of
  profile/task names to compiled files and runs the right one with
  `eval(readFile(...))`.

How the dispatcher picks the file:

1. **Explicit `%par1`** (a profile or task name) wins; `%par2` = `exit`
   selects a profile's exit file. Use this from Perform Task, widgets, etc.
2. Otherwise it reads Tasker's **`%caller1`**, which for profile-launched
   tasks is `profile=enter:<name>` or `profile=exit:<name>` — so a new
   profile only needs its trigger plus `TE Dispatch` as both its enter and
   its exit task. No per-task file paths, no per-task UI work.

Unknown names or unreadable files `flash()` a clear error. The JS directory
defaults to `/sdcard/Tasker/js/` and can be overridden with the Tasker
global `%TE_JS_DIR` (also edit the path inside the imported task if you do).

Because `dispatcher.js` is a regular `.js` release asset it updates through
the normal sync, keeping the name→file map current. The `.tsk.xml` is *not*
synced (sync pulls only `.js` on purpose): download it manually once from
the latest release — it only ever contains the pointer to `dispatcher.js`,
so it never goes stale.

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

**One-time device setup:**

1. Download `sync-profiles.js` from the latest release to
   `/sdcard/Tasker/js/` (any way you like — browser, `adb push`, …).
2. In Tasker, create a task **Sync** with a single **JavaScript** action
   pointing at that file, with *Auto Exit* disabled.
3. Create a profile that runs **Sync** whenever you want updates: a daily
   Time trigger, "connected to home Wi-Fi", an NFC tag, or just a home
   screen shortcut.
4. Download `tasker-effect.tsk.xml` from the release and import it once
   (Tasks tab → long-press → *Import Task*) to get the shared `TE Dispatch`
   task.
5. For each of your profiles, configure its trigger in the Tasker UI (the
   generated `README.md` asset lists them) and set `TE Dispatch` as the
   enter and exit task. Standalone tasks run via Perform Task →
   `TE Dispatch` with `%par1` = the task name.

**How updates propagate:** Tasker reads the `.js` file from disk every time
an action runs — nothing is cached. Each **Sync** run overwrites
`/sdcard/Tasker/js/` with the newest release assets (via Tasker's own
`writeFile`), so the next time any profile fires it executes the new code.
This applies to DSL-generated files, Effect bundles, and `sync-profiles.js`
itself, which updates its own file too.

**The one manual step that remains:** Tasker's JS API cannot create
profiles or triggers, so a *brand-new* profile still needs its trigger
configured once in the UI (step 5) — but thanks to the dispatcher that is
all: the task slots always point at `TE Dispatch`, and the dispatcher's
name→file map updates itself on every sync. After that, every change to
its code ships automatically.
Point the sync at your own fork with the Tasker globals `%SYNC_OWNER` /
`%SYNC_REPO`.

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
- `Match` (with `Match.exhaustive`) for the compiler's action/trigger/op
  dispatch — adding a variant fails typecheck until every site handles it
- `Layer` composition to swap Node vs Tasker implementations of storage,
  HTTP and zip extraction (`TaskerFileStore`, `TaskerProfileSyncLive`)

## License

MIT
