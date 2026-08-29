# tasker-effect — Effect/TypeScript audit

## Orientation

> **Provenance.** Generated against the tree at commit `dadd35a` (master `0b1207a` + the `Condition`
> union). `master` has since advanced to `cea8b76` (PR #7: vitest coverage to 100%, plus review fixes
> to `src/sync/node.ts`). Findings were re-verified against `dadd35a`; line numbers in files that PR #7
> touched — `src/sync/node.ts`, `src/cli.ts` and most of `test/` — may be a few lines out, and a small
> number of `sync/node.ts` findings may be partly addressed there. Spot-checked as still open after
> `cea8b76`: `Effect.context` re-provision (`sync/node.ts:82`) and the `FileStore`/`ZipExtractor`
> tag-subclasses (`:126`). Everything in `src/compiler.ts`, `src/profile.ts`, `src/config.ts` and
> `tasks/` is unaffected by PR #7.

Audited the full tree at `/home/user/tasker-effect`: `src/` (compiler, profile DSL, tasker-api, cli, config, runtime, sync/{contract,core,node,tasker}), the newer `tasks/popular/*` and `tasks/scripts/*`, `scripts/compile-tasks.ts`, `examples/`, and all 12 test files. Baseline on the audited tree: `bun run typecheck` clean, `bun run lint` clean (oxlint 1.78 with the ~90-rule `@effect/tsgo` recommended preset), `bun test` 189/189 passing. **Every finding a linter already enforces was excluded** — `try-catch-in-effect-gen`, `floating-effect`, `leaking-requirements`, `missing-layer-context`, `unsafe-effect-type-assertion`, `unnecessary-effect-gen`, `catch-to-ignore`, `global-*`, `prefer-schema-over-json` and the rest of the preset were checked against each candidate and anything they cover was dropped. What is listed below is therefore, by construction, what automation will not catch for you. Where a lint rule looks adjacent but stays silent, the entry says which rule and why. Most fixes were applied to a scratch tree and re-run through typecheck/lint/tests; where a proposed fix broke something, that is stated. Line numbers were re-anchored on the current tree; a handful of `src/profile.ts` anchors sit a few lines from older records because commit `dadd35a` (Condition → `Comparison | Presence`) shifted the file.

---

## Top 5 highest-leverage fixes

1. **`src/profile.ts:86` — `isGlobalVariable` implements the wrong Tasker rule.** One predicate feeds every emitted `global()`/`local()`; mixed-case globals silently read nothing on-device. **S**
2. **`src/sync/tasker.ts:43,70` — the on-device FileStore/ZipExtractor throw away `writeFile`/`unzip`'s `false`.** A refused write is reported as a successful sync, forever, with a green toast. **S**
3. **`tasks/scripts/sync-profiles.ts:33` — sync ignores `%TE_JS_DIR`/`%TE_GH_TOKEN`.** The documented directory override permanently desyncs the device and never self-corrects. **S**
4. **`src/compiler.ts:321` — task/profile names are interpolated raw into the emitted block comment.** A `*/` in a name either emits a file that will not parse (green CI, dead device) or escapes the comment into live top-level code. **S**
5. **`src/compiler.ts:1198` — `compileProjectFiles` has no filename-collision or reserved-name check.** Two names that slugify alike silently overwrite each other's JS and the dispatcher routes both to one file. **S/M**

Just below the cut, both cheap: `src/config.ts:168` (discarded `performTask` boolean) and `src/profile.ts:793` (the `ActionSchema` cast that lets the action union desync silently).

---

## Correctness — real bugs

**`src/profile.ts:86` — [HIGH] `isGlobalVariable` requires an all-caps name, but Tasker's rule is "contains at least one capital", so every mixed-case global compiles to `local()`.**
Tasker's documented scoping (its own example is `%Wifi_Timeout`) makes any name with a capital global; only all-lowercase names are local. Verified emissions: `v("Wifi_Timeout")` → `local("Wifi_Timeout")`, and `cond("%Wifi_Timeout","gt","30")` → `parseFloat(local("Wifi_Timeout")) > parseFloat("30")` → `NaN > 30` → permanently false, silently. It fails the other way too: Tasker's event-*locals* are all-caps (`%SMSRF`, `%LOCN`), so they compile to `global()` and read nothing — which is exactly why `tasks/popular/driving.ts:51` drops into raw JS.

```ts
// before
export const isGlobalVariable = (name: string): boolean => {
  const bare = percentLess(name);
  return bare === bare.toUpperCase();
};
// after
export const isGlobalVariable = (name: string): boolean => /[A-Z]/.test(percentLess(name));
```

Applied: typecheck, lint and 189/189 stay green — which also exposes that `test/profile.test.ts:213-214` only covers `%BATT` and `counter`, the two cases both rules agree on. Note `%1`..`%9` flip to local, which is correct for task params but deserves a test. Because a heuristic can never separate a user global from an all-caps built-in local, pair this with an explicit `scope` on `VariableRef` (see the `driving.ts:49` finding). Also fix the doc comments at `profile.ts:85`, `profile.ts:257-258` and `README.md:234`, which state the wrong rule. No preset rule models the Tasker variable namespace.

**`src/compiler.ts:321` — [HIGH] `header()` interpolates user names and descriptions raw into the emitted `/** … *​/` block, so `*/` either breaks the file or escapes into live code.**
Every other user string goes through `js()`/`JSON.stringify`; this one does not. Reproduced by running the compiler: a task named ``Evil */ ; globalThis.PWNED = 1; /*`` emits a header whose comment closes early, and executing the emitted source sets `PWNED` — top-level, *outside* the generated `try/catch` guard. A description of exactly `*/` emits a file that fails to parse (`SyntaxError`), which CI cannot see and which surfaces on-device only as a generic dispatch-failed toast from `eval(source)` (compiler.ts:594). `test/support/valid-js.ts` cannot catch the injection variant because the injected file parses fine. Same hazard in `scaffoldHeader` (`:699`) and via `Dispatcher: ${project.name}` (`:534`).

```ts
const commentSafe = (v: string): string => v.replace(/\*\//g, "*\\/").replace(/[\r\n]+/g, " ");
// :323-324
` * ${commentSafe(title)}`,
...(description !== undefined ? [` * ${commentSafe(description)}`] : []),
```

Applied: typecheck/lint/189 green; the probe then emits `Task: Evil *\/ …` with `PWNED: undefined`. The day-to-day bug is (b) — the author breaks their own build silently — since the "attacker" is normally the repo owner. No template-injection rule exists in the preset.

**`src/sync/tasker.ts:43` — [HIGH] `Effect.asVoid` discards `writeFile`'s boolean, so a refused on-device write is reported as a successful sync.**
`src/tasker-api.ts:334` declares `writeFile(...): boolean` — Tasker signals refusal (missing storage permission, unwritable `%TE_JS_DIR`) by *returning false*, and `liveFn` (tasker-api.ts:608-625) only converts *throws* into `TaskerCallError`. So `sync/core.ts:141` pushes the asset into `written`, `pullLatestProfiles` returns a `SyncResult` listing files that were never created, and `sync-profiles.ts:35` flashes "synced 9 file(s)" over an untouched directory — every 6 hours, running last week's `dispatcher.js`. Identical at `:70-71`, where `unzip`'s boolean is replaced by `Effect.as([])`.

```ts
tasker.writeFile(path, content, false).pipe(
  Effect.filterOrFail(
    (written) => written !== false,           // compare to false: test stubs return undefined
    () => new StorageWriteError({ message: "Tasker writeFile() returned false", path })
  ),
  Effect.asVoid,
  Effect.catchTags({ /* unchanged */ })
)
```

Applied at both sites: typecheck/lint/189 green (declared error unions unchanged). `effect-map-void` actively pushes *toward* `asVoid`; no rule knows this boolean is a failure signal.

**`tasks/scripts/sync-profiles.ts:33` — [HIGH] the on-device sync ignores `%TE_JS_DIR` and `%TE_GH_TOKEN`, so the documented directory override desyncs the device permanently.**
Every other on-device component resolves the directory from `%TE_JS_DIR` — the dispatcher (`compiler.ts:546`), `jsDirPreamble` (`:646`), both TE Config stubs — and `README.md:188` plus the generated README (`compiler.ts:1044`) document it as supported. But `pullLatestProfiles({ owner, repo })` passes no `targetDir`, so `sync/core.ts:118` falls back to `/sdcard/Tasker/js`. Set `%TE_JS_DIR=/sdcard/te/` and TE Sync bootstraps into `/sdcard/te/`, sync writes everything to `/sdcard/Tasker/js/`, and TE Dispatch flashes "could not read" on every trigger while sync flashes success. Same asymmetry for auth: the bootstrap XHR sends `%TE_GH_TOKEN` (`compiler.ts:673`) but `SyncOptions.token` is never populated, so a private repo bootstraps once then 404s forever.

```ts
const dir = yield* globalOr("TE_JS_DIR", DEFAULT_TARGET_DIR);   // from ../../src/sync/contract.js
const token = yield* globalOr("TE_GH_TOKEN", "");
const result = yield* sync.pullLatestProfiles({
  owner, repo,
  targetDir: dir.replace(/\/+$/, ""),        // core.ts:139 joins with "/"
  ...(token !== "" ? { token } : {}),
});
```

Both fields already exist on `SyncOptions` (`contract.ts:109/111`). Also reconcile `compiler.ts:1048`, which claims sync keeps `tasker-effect.prj.xml` current — false once the override is set.

**`src/compiler.ts:1198` — [HIGH] `compileProjectFiles` performs no filename-uniqueness or reserved-name check, so distinct profiles/tasks silently overwrite each other's JS.**
`checkTaskReferences` is the only project-level validation. Proven by running the compiler: profiles `"Night Mode"` and `"Night-Mode"` both slugify to `night-mode`, producing two `CompiledFile` entries with the same filename and different bodies, and a dispatcher mapping both names to `night-mode.enter.js`; `scripts/compile-tasks.ts:36-39` writes in order so the second body wins. A task named `"Dispatcher"` emits `dispatcher.js`, which the real dispatcher (pushed *after* the task loop) overwrites while `TASKS` still points at it — dispatching that task `eval`s the dispatcher with `%par1` unchanged, i.e. unbounded recursion to Tasker's 600s timeout. A task slugging to `sync-profiles.js` is silently replaced by `bundleEffectScripts`, which runs into the same output dir with no check at all. `src/cli.ts:295-298` only *warns*, and only across top-level exports, so it never sees the intra-project case.

```ts
const RESERVED = new Set([DISPATCHER_FILENAME, CONFIG_SCAN_FILENAME, CONFIG_LABEL_FILENAME,
  SECRETS_FILENAME, TASKER_PROJECT_XML_FILENAME, SYNC_SCRIPT_FILENAME, "README.md"]);
const checkFilenames = (project: Project): void => { /* claim() each emitted name; throw CompileError on reuse or reserved */ };
// call at :1198, right after checkTaskReferences(project)
```

Applied: typecheck/lint/189 green, `bun run compile` still emits 29 files, colliding probe now throws. No rule models generated-artifact identity.

**`src/profile.ts:204` — [HIGH] `VarName` accepts any non-empty string in *global* positions, so `setGlobal("mode", …)` writes a global that every read compiles to `local("mode")`.**
`Secret.name` already enforces `/^[A-Z][A-Z0-9_]*$/` (`:91`), but `SetGlobal.name` and the three `outputGlobal` fields (`:296, :360, :366, :391`) do not. Reproduced: `[Action.setGlobal("mode","night"), Action.when(cond("mode","eq","night"), […])]` emits `setGlobal("mode","night");` and `if (local("mode") === "night")` — the branch never fires, with no error anywhere.

```ts
export const GlobalName = Schema.NonEmptyString.pipe(
  Schema.pattern(/^%?[A-Z][A-Z0-9_]*$/, { identifier: "GlobalName" })
);
export const GlobalVarName = Schema.Union(GlobalName, Secret);
// use for SetGlobal.name (296), Shell/ReadFile/HttpRequest.outputGlobal (360/366/391)
```

Applied: typecheck clean, 189/189 — a pure tightening, no call site violates it. Leave `Condition.variable` on `VarName`; conditions may legitimately read locals, and closing the *write* side is what removes the mismatch. Fix this together with `isGlobalVariable` above.

**`src/config.ts:168` — [HIGH] `performTask`'s boolean result is discarded, so an absent `TE Config` polls the full 120-attempt budget instead of failing immediately.**
`performTask` returns `boolean` (`tasker-api.ts:485`) and `Effectified` puts it in the success channel (`:587-590`); only the *error* channel is mapped here. When `TE Config` does not exist (the user never imported `tasker-effect.prj.xml`), `false` is dropped, `taskRunning` is never true, `seenRunning` never flips, the dismissal shortcut at `:192-204` is unreachable, and an immediately-knowable hard negative becomes an indistinguishable timeout. Wholly untested — the double at `test/config.test.ts:28-34` returns `true` unconditionally.

```ts
const started = yield* tasker.performTask(...).pipe(Effect.mapError(...));
if (!started) {
  return yield* Effect.fail(ConfigError.MissingData([...path],
    `${CONFIG_TASK_NAME} could not be started for %${name} — import tasker-effect.prj.xml`));
}
```

`MissingData` is the right variant: it satisfies `isMissingDataOnly`, so `Config.withDefault`/`option` still compose. Applied: typecheck clean, suite unchanged. `effect-in-void-success`/`effect-map-void` concern an Effect's declared success *type*, not a discarded binding.

**`src/compiler.ts:563` — [MED] the dispatcher resolves `PROFILES` before `TASKS` with no name-uniqueness check, so `performTask` can run the wrong file.**
A profile and a standalone task both named `"Backup"` compile cleanly — `checkTaskReferences` (`:1174`) only checks `project.tasks`, so `Action.performTask(backupTask)` passes the linker. The dispatcher then embeds both maps and, consulting `PROFILES` first, runs `backup.enter.js` instead of `backup.js`. Filenames do not collide, so nothing else catches it: no compile error, no runtime flash, just the wrong automation. Fix inside `checkTaskReferences`, which already throws `CompileError`:

```ts
const profileNames = new Set(project.profiles.map((p) => p.name));
for (const task of project.tasks) if (profileNames.has(task.name))
  throw new CompileError({ message: `"${task.name}" is both a profile and a task; the dispatcher resolves %par1 against profiles first`, source: project.name });
```

While there, reject duplicate names *within* each list — the emitted map literals (`:528-534`) silently keep the last key.

**`src/compiler.ts:135` — [MED] `emitJsCode`'s catch-all branch compiles `Action.js(v(…))` / `Action.js(secret(…))` into a dead expression statement instead of failing.**
`JavaScript.code` is `NonEmptyText` (`profile.ts:636-638`), so both are constructible. Verified: `emitAction(Action.js(v("MY_SNIPPET")))` → `["global(\"MY_SNIPPET\");"]` — the action reads a Tasker variable and discards it. `expectValidJs` passes because the output is syntactically valid. Narrow the field so the tail is exhaustive by construction:

```ts
export const JsCode = Schema.Union(Schema.NonEmptyString, Interpolated);   // profile.ts, next to NonEmptyText
// JavaScript.code: JsCode; js: (code: JsCode) => …
const emitJsCode = (code: JsCode): Array<string> =>
  typeof code === "string" ? code.split("\n") : code.parts.map(/* unchanged */).join("").split("\n");
```

Non-breaking on this tree — no call site passes a bare `Secret`/`VariableRef`. `instance-of-schema` is disabled by policy and would only touch the narrowing style; no rule can see that `global("X");` is a no-op.

**`tasks/scripts/adaptive-night-mode.ts:78` — [MED] sun times returned in the *location's* zone (`timezone=auto`) are compared against the *device's* zone.**
Line 48 requests `&timezone=auto`, so open-meteo renders sunrise/sunset in the zone it resolves from the coordinates and reports it in a top-level `timezone` field; `SunResponse` (`:29-34`) drops it and `DateTime.withCurrentZoneLocal` supplies the device zone. Reducing both sides to bare HH:MM integers (`:81-85`) destroys any signal that two zones were mixed, so `isNight` shifts by the offset difference whenever the phone is not at home — including the documented Madrid-default path. Decode the zone and forward it out of `fetchSunTimes` (it is top-level, not inside `daily`):

```ts
const now = yield* DateTime.nowInCurrentZone.pipe(
  DateTime.withCurrentZoneNamed(timezone),
  Effect.orElse(() => DateTime.nowInCurrentZone.pipe(DateTime.withCurrentZoneLocal))
);
```

The `orElse` matters: `withCurrentZoneNamed` (DateTime.d.ts:1527) raises `IllegalArgumentException`, which the `catchTags` at `:93-104` does not handle. `global-date`/`global-date-in-effect` only push you toward `DateTime`, which this code already uses; nothing checks zone provenance.

**`src/config.ts:183` — [MED] a transient `global()` failure while polling escapes as `SourceUnavailable`, which `Config.withDefault`/`option` provably cannot recover — and both shipped scripts depend on that recovery.**
`readGlobal` maps every `TaskerApiError` to `SourceUnavailable` (`:85-94`). Verified in the installed effect (`internal/config.js:219-224`, `:378-381`): both recovery combinators only rescue when `ConfigError.isMissingDataOnly`. So one bridge hiccup during a 120-iteration wait aborts the whole on-device script instead of taking the default — and `morning-briefing.ts:49-50` and `adaptive-night-mode.ts:58-59` both rely on `withDefault`. The very next statement takes the opposite decision for `taskRunning` with a comment saying a probe failure "must not fail the read".

```ts
const probeGlobal = readGlobal(path, name).pipe(Effect.orElseSucceed(() => undefined));
// used at the per-tick read (:183) and the post-dismissal re-read (:196); keep the strict mapping in load() (:255)
```

No test overrides `global` to fail, so this path has zero coverage. `catch-all-to-map-error`/`redundant-map-error` inspect the mapping's shape, not which `ConfigError` variant the recovery predicate accepts.

**`src/sync/core.ts:134` — [MED] `pullLatestProfiles` interleaves download and write, leaving a torn mix of new and stale files when one asset fails.**
Each asset is fetched and immediately committed, so any mid-loop failure aborts with earlier assets overwritten and later ones stale — and the `SyncResult` carrying `written` is discarded with the error, so nobody can tell how far it got. The assets are mutually dependent: `dispatcher.js` is the name→file map, `secrets.json` drives TE Config, and `sync-profiles.js` overwrites the running script. Order is whatever GitHub returned, so the torn state is nondeterministic. Split the phases and order the commit so the map lands last:

```ts
const downloaded = yield* Effect.forEach(assets, (a) =>
  getText(a.browser_download_url, options.token).pipe(
    Effect.map((content) => ({ name: a.name, path: `${targetDir}/${a.name}`, content }))));
// sort dispatcher.js / sync-profiles.js last, then:
yield* Effect.forEach(ordered, (f) => files.writeText(f.path, f.content).pipe(
  Effect.tap(() => Effect.log("Synced release asset", { asset: f.name, path: f.path }))), { discard: true });
```

Verified green. Keep it sequential — on-device this runs in Tasker's WebView, and parallel ~350 KB downloads on mobile data are a regression risk. This removes the download-failure window, not write-phase atomicity: `FileStoreShape` exposes only `writeText`/`writeBytes`, no rename, so commit *ordering* is the available mitigation. It also buffers all bodies in memory first.

**`tasks/scripts/adaptive-night-mode.ts:87` — [MED] `enableProfile` cannot move a Time-context window, so the sun computation never changes when Night Mode activates, and `%NIGHT_START`/`%NIGHT_END` are read by nothing.**
The paired profile (`tasks/popular/quiet.ts:15`) has a single context: `Trigger.time({hour:22,minute:30},{to:{hour:6,minute:30}})`. Enabling a profile only *arms* it; the Time context still gates activation, so the script can at best suppress part of the hard-coded window, never shift it with the sun — and at the default Madrid coordinates `isNight` is true across essentially that whole window year-round, so the script changes nothing while flashing a status toast every 30 minutes. Grep over the repo shows `%NIGHT_START`/`%NIGHT_END` are written and read nowhere. Drive the profile off state the script owns:

```ts
// quiet.ts:15
triggers: [Trigger.variable(cond("%NIGHT_WINDOW", "eq", "1"))]   // profile.ts:1268/1254; rendered by compiler.ts:396-399
// adaptive-night-mode.ts:87
yield* tasker.setGlobal("NIGHT_WINDOW", isNight ? "1" : "0");
```

Also demote the per-run flash to transitions only. If the enable-only pairing is genuinely intended, re-document the two globals as outputs for hand-built profiles. No rule models Tasker profile-context semantics or cross-file dataflow.

---

## Effect guarantees defeated

**`src/compiler.ts:1264` — [HIGH] `tryCompile` launders every defect into a typed `CompileError` via `String(cause)`, and fabricates an error channel for two total functions.**
Three separate losses. (a) `Match.exhaustive` is a real throw site invisible to `grep throw` — `internal/matcher.js:300` throws `"effect/Match/exhaustive: absurd"`, and `emitAction` (`:306`), `conditionExpr` (`:154`) and `describeTrigger` (`:411`) all end in it; every such defect reaches the user as `Compilation failed: …` at `cli.ts:427-433` with exit 1, indistinguishable from a legitimate linker failure and with the stack discarded. (b) `CompileError` (`:33-40`) has only `message` and `source` — `String(cause)` destroys the object, its stack and any nested cause. (c) `grep -n 'throw '` returns only lines 1095 and 1167, both inside `checkTaskReferences`/`collectProjectSecrets`; `compileTaskToJs` and `compileProfileFiles` contain no throw at all, so `compileTask` (`:1281`) and `compileProfile` (`:1292`) declare a `CompileError` channel that only a laundered defect can populate — an error every caller must handle that can only ever be a bug.

```ts
compileTask: (task) => Effect.sync(() => ({ filename: `${slugify(task.name)}.js`, content: compileTaskToJs(task), kind: "task-js" as const })),
compileProfile: (profile) => Effect.sync(() => compileProfileFiles(profile)),
compileProject: (project, options) => Effect.suspend(() => /* throwing core, still typed CompileError via a narrow Effect.try */),
```

Keep the narrow `Effect.try` only around `compileProjectFiles` (it genuinely throws `CompileError`), and let defects stay defects so the runtime prints the full `Cause`; at the CLI edge add `Effect.catchAllDefect((d) => Effect.logError(Cause.pretty(Cause.die(d))))` rather than folding it into "Compilation failed". Prefer `Predicate.isTagged(cause, "CompileError")` to the nominal `instanceof` if a narrowing wrapper survives. `unknown-in-effect-catch` constrains the catch parameter's *type* (already `unknown`); no rule models "a defect was converted into a typed error".

**`src/profile.ts:793` — [HIGH] the `as unknown as Schema.Schema<Action, ActionEncoded>` cast lets `actionMembers` and the hand-written `Action` union desync with a clean typecheck.**
Proven in a worktree: adding a `Schema.TaggedClass` to `actionMembers` *without* adding it to the `Action` union leaves `bun run typecheck` at exit 0 — the schema then decodes a value `emitAction`'s `Match.exhaustive` cannot handle, and `Task.actions = Schema.NonEmptyArray(ActionSchema)` (`:939`) propagates the unchecked claim to every decoded task. The reverse direction *is* caught (TS2345 at `compiler.ts:306`), so the cast removes exactly the remaining half. `ActionEncoded` (`:746`) is additionally `{ _tag: string } & Record<string, unknown>`, so `decode({ _tag: "NotARealTag" })` typechecks and `.members` is erased from `ActionSchema` (unlike `TriggerSchema`). The cast is load-bearing — deleting it alone fails TS2322 at the two `Schema.suspend` sites, and deriving `ActionEncoded` from the union is circular through `If`. The one refactor that works is splitting the member tuple:

```ts
const flatActionMembers = [Flash, Popup, /* …39 leaves… */, JavaScript] as const;
type FlatAction = Schema.Schema.Type<(typeof flatActionMembers)[number]>;
type FlatActionEncoded = Schema.Schema.Encoded<(typeof flatActionMembers)[number]>;
interface IfEncoded { readonly _tag: "If"; readonly condition: Schema.Schema.Encoded<typeof Condition>;
  readonly then: ReadonlyArray<ActionEncoded>; readonly orElse?: ReadonlyArray<ActionEncoded>; }
export type Action = FlatAction | If;
export type ActionEncoded = FlatActionEncoded | IfEncoded;
const actionMembers = [...flatActionMembers, If] as const;
export const ActionSchema = Schema.Union(...actionMembers);   // cast and hand-written unions gone
```

Applied verbatim: typecheck clean, lint exit 0, 189/189, `.members` becomes typed and enumerable, and the drift probe now fails with TS2345. If the refactor is too large for now, the one-line stopgap that closes the worst hole is a type-level bridge asserting `Schema.Schema.Type<typeof ActionUnion>` and `Action` are mutually assignable — verified to compile and to fire on drift. `unsafe-effect-type-assertion` targets `Effect`-typed assertions, never `Schema.Schema<A, I>` — the documented gap.

**`src/config.ts:303` — [MED] `taskerConfigLayer` self-provides `Tasker.Default`, closing the test seam on the only wiring the shipped scripts use.**
All 18 provider tests go through `makeTaskerConfigProvider(api, …)`, handing the service value over by hand, so `taskerConfigLayer` — used by both `morning-briefing.ts:90` and `adaptive-night-mode.ts:110` — has no test at all: nothing checks that the layer installs the provider, or that `options.secrets` reaches the labels map, and no recording `Tasker` can be substituted.

```ts
export const taskerConfigLayer = (options?: TaskerConfigOptions): Layer.Layer<never, never, Tasker> => /* body unchanged, provide removed */;
export const taskerConfigLayerLive = (options?: TaskerConfigOptions): Layer.Layer<never> =>
  taskerConfigLayer(options).pipe(Layer.provide(Tasker.Default));
```

Applied: typecheck/lint/189 green, `bun run compile` succeeds, and both scripts typecheck **unchanged**, because `runInTasker` already accepts `Effect<A, E, Tasker>` and provides `Tasker.Default` last (`runtime.ts:41-47`). `missing-layer-context` is satisfied (the annotation is accurate once provided) and `multiple-effect-provide` does not fire across modules; nothing detects a redundantly self-satisfied dependency.

**`src/sync/tasker.ts:61,82` — [MED] the on-device capability layers self-provide `Tasker.Default`, so a test that tries to substitute a Tasker silently binds the real one.**
Both are typed `Layer.Layer<FileStore>` / `Layer.Layer<ZipExtractor>` with no `Tasker` in R, and providing one from outside is a no-op. Demonstrated at HEAD: a test using `makeTaskerTestLayer({ writeFile: () => Effect.fail(new TaskerCallError(...)) })` via `TaskerFileStore.pipe(Layer.provide(layer))` compiles and runs but binds the live Tasker — it failed on `Received: "Tasker builtin \"writeFile\" is not defined…"` instead of the stub's message. Consequently the error mapping at `:44-49`/`:72-77` and the unconditional `writeBytes` failure at `:51-57` are unreachable from any test; the node side *is* covered precisely because `test/sync.test.ts:93` can stub `FileStore` directly.

```ts
export const TaskerFileStore: Layer.Layer<FileStore, never, Tasker> = Layer.effect(FileStore, /* unchanged */);
export const TaskerZipExtractor: Layer.Layer<ZipExtractor, never, Tasker> = Layer.effect(ZipExtractor, /* unchanged */);
export const SyncTaskerLive: Layer.Layer<ProfileSync> = ProfileSync.Default.pipe(
  Layer.provide(Layer.mergeAll(FetchHttpClient.layer, TaskerFileStore, TaskerZipExtractor)),
  Layer.provide(Tasker.Default));
```

Applied: typecheck/lint/189 green, `SyncTaskerLive`'s public type unchanged, and the probe test passes for the right reason. Keep an assertion on `error.message`, not just `_tag` — `_tag` alone passes under the closed seam too. (Drop the "two Tasker instances" rationale: layer memoisation builds it once — verified.)

**`src/sync/node.ts:64` — [MED] the Node capability layers self-provide `NodeContext.layer`, collapsing R to `never` so `FileSystem`/`CommandExecutor` can never be substituted.**
Same shape as above, in the other platform module. No test can hand `FileStoreNodeLive` an in-memory FileSystem or a stub executor to exercise the `StorageWriteError`/`ZipExtractError` mappings at `:43-48` and `:90-99` — and none does. The callers already show the confusion: `test/cli.test.ts:21-25` and `scripts/compile-tasks.ts:91` merge a `NodeContext` the layers ignore.

```ts
export const FileStoreNodeLive: Layer.Layer<FileStoreTag, never, FileSystem.FileSystem | Path.Path> = /* provide removed */;
export const ZipExtractorNodeLive: Layer.Layer<ZipExtractorTag, never, FileSystem.FileSystem | CommandExecutor.CommandExecutor> = /* … */;
export class FileStore extends FileStoreTag {
  static readonly Default: Layer.Layer<FileStoreTag> = FileStoreNodeLive.pipe(Layer.provide(NodeContext.layer));
}
```

Applied: typecheck/lint/189 green with **no** edits to any `.Default` call site. `missing-layer-context` and `leaking-requirements` both flag *under*-declared context; over-providing satisfies them by construction.

**`src/config.ts:123` — [MED] `global`/`local` are declared to return `string` but can return `undefined`; three sites work around it independently.**
`TaskerRawApi` declares `global(varName: string): string` (`tasker-api.ts:202`) and `liveFn` hands back the bridge's value through `as TaskerApi[K]` (`:625`), so every consumer is told the success is a string. This module widens locally (`config.ts:123`, and again at `:158-161`); `tasks/scripts/sync-profiles.ts:24` writes `value === "" || value === undefined` — dead by the types, load-bearing at runtime; `tasks/scripts/battery-report.ts:20` runs `Number.parseInt(battery, 10)` with no guard. Fix the declaration once:

```ts
global(varName: string): string | undefined;   // tasker-api.ts:202
local(varName: string): string | undefined;    // :206
```

Applied: `bun run typecheck` (src-only) stayed clean, and typechecking the scripts separately surfaced exactly one error — `battery-report.ts(20,33): TS2345` — which is the latent hole made visible. `unsafe-effect-type-assertion` stays silent because the `as` target is a function-typed API-record property, not an Effect.

**`src/sync/core.ts:83` — [MED] `downloadErrors` retypes `RequestError`/`ResponseError` structurally with `reason: string`, discarding the literal unions.**
`ResponseError.reason` is `"StatusCode" | "Decode" | "EmptyBody"` and `RequestError.reason` is `"Transport" | "Encode" | "InvalidUrl"` (`HttpClientError.d.ts:32,49`). The hand-written parameter shapes widen `reason` to `string`, so `error.reason === "Statuscode"` — or any upstream rename — compiles and silently takes the `else` branch, turning every non-2xx download into a generic message with no status. `morning-briefing.ts:78` does the same comparison against the real inferred type and would break loudly. The `RequestError` handler erases `reason` entirely, so an `InvalidUrl` (a bug in the constructed asset URL) reads exactly like a network drop.

```ts
import { HttpClientError } from "@effect/platform";
RequestError: (error: HttpClientError.RequestError) => Effect.fail(new DownloadError({ message: `${error.reason}: ${error.message}`, url })),
ResponseError: (error: HttpClientError.ResponseError) => /* unchanged body, now type-checked */,
```

Applied (parameter types only): typecheck/lint/189 green. Adding `status: Schema.optional(Schema.Number)` to `DownloadError` (so callers can recover it structurally the way `GitHubApiError` allows) is a separate, unverified follow-up. No `as` exists here, so `unsafe-effect-type-assertion` cannot see it — the widening happens by ordinary assignability of an annotated handler parameter.

**`src/cli.ts:146` — [MED] `decodeOrUndefined` discards every `ParseError`, so a near-miss cross-realm export is dropped in total silence.**
`asCompilable` (`:151-172`) exists specifically for objects built by a *different copy* of the library, where `instanceof` fails — exactly the version-skew case where decoding fails on one action or trigger. `Either.getOrUndefined` collapses the Left, `collectCompilables` flatMaps the `undefined` away, and the user gets either `NoCompilableExportsError` ("has no compilable exports", actively misleading) or a partial compile that omits one export and exits 0. The message naming the offending field is destroyed at the only point it exists.

```ts
export const asCompilableEither = (value: unknown):
  Either.Either<Project | Profile | Task, ParseResult.ParseError> | undefined => /* same dispatch, returns the Either */;
// in compileEntry, before NoCompilableExportsError:
yield* Console.warn(`warning: export "${name}" looks like a DSL definition but failed to decode: ${ParseResult.TreeFormatter.formatErrorSync(error)}`);
```

Keep `asCompilable`'s exported signature (test/cli.test.ts:64-73 depends on it) and keep the diagnostic a *warning* — the shape gate is loose enough that unrelated exports can reach it. `prefer-typed-schema-decoder` is satisfied; `catch-to-ignore` only matches Effect combinators, not a discarded `Left`.

**`src/runtime.ts:48` — [MED] `runInTasker` provides `Tasker` before its own handlers, forcing the throwing `raw` proxy and hand-rolled try/catch on the one failure path in the codebase.**
Because `Effect.provide` runs first, neither handler can require `Tasker` without resurfacing the requirement, so both reach past the service to the throwing `raw` proxy (`tasker-api.ts:727-739`) and hand-roll exception handling the service already models as `TaskerNotAvailableError`/`TaskerCallError`. The crash-report flash is therefore unobservable to a recording layer, and no test asserts that a failing program flashes anything.

```ts
program.pipe(
  Effect.tapErrorCause((cause) => Tasker.use((t) => t.flash(`tasker-effect: ${Cause.pretty(cause)}`)).pipe(Effect.ignore)),
  Effect.ensuring(options?.exitWhenDone === true ? Tasker.use((t) => t.exit()).pipe(Effect.ignore) : Effect.void),
  Effect.provide(Tasker.Default)
)
```

`tryFlash` (`:26-32`) and the `raw` import both disappear. Applied: typecheck/lint/189 green. `try-catch-in-effect-gen` fires only inside `Effect.gen`; no rule reasons about pipe order relative to `Effect.provide`.

**`src/tasker-api.ts:690` — [MED] `makeTestTasker` records and resolves at Effect-*construction* time while the live binding is `Effect.suspend`-lazy.**
`liveFn` (`:608-625`) re-looks-up the global and re-invokes the builtin on every *run*; the double does its work when the method is *called*. So `const check = tasker.global("BATT"); yield* Effect.repeat(check, Schedule.recurs(2))` performs three real reads on-device but records one call and replays one frozen value under test. The eagerness leaks into overrides: `test/config.test.ts:27` reads its mutable map at construction and only works because `config.ts:185` re-invokes `tasker.global(name)` each poll — move that read behind a retry and the double silently stops tracking. The helper is exported from `src/index.ts`.

```ts
(...args: ReadonlyArray<unknown>) => Effect.suspend(() => {
  calls.push({ name, args });
  const override = overrides[name];
  return override !== undefined ? (override as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown, TaskerApiError>)(...args)
                                : Effect.succeed(testDefault(name));
})
```

Applied: typecheck/lint/189 green. Delta: an Effect built but never run stops appearing in `calls` (nothing depends on that today). `lazy-effect`/`sync-to-succeed` cannot see that `calls.push` is meant to be execution-scoped.

**`src/tasker-api.ts:700` — [LOW] `makeTestTasker`'s `overrides` parameter cannot reach `isAvailable`, so the on-device branch is untestable through the exported helpers.**
`isAvailable` lives on `TaskerShape` (`:600`), not on the `TaskerApi` mapped type, and the double pins it to `Effect.succeed(false)`. Any program branching on `if (yield* tasker.isAvailable)` — the flag's whole purpose — is testable only along its off-device branch. **Open the seam, do not reverse it** (`test/tasker-api.test.ts:52` asserts `false`, and `TaskerTest`'s documented meaning depends on it):

```ts
export const makeTestTasker = (overrides: Partial<TaskerShape> = {}) => /* … */
  ({ api: { ...api, isAvailable: overrides.isAvailable ?? Effect.succeed(false) }, calls });
// same widening on makeTaskerTestLayer (:712)
```

Applied: typecheck/lint/189 green including the existing `false` assertion. No rule covers test-double completeness.

---

## Hand-rolled where an Effect primitive exists

**`src/config.ts:225` — [MED] `uninterruptibleMask` + `Effect.exit` + two taps + a manual re-raise is exactly `Effect.onExit`.**
`internal/core.js:569-581` implements `onExit` as `uninterruptibleMask(restore => matchCauseEffect(restore(self), …))`, running the cleanup on success, failure and interruption — byte-for-byte the guarantee the 8-line comment at `:214-219` defends — and additionally sequences a cleanup failure into the original cause, which the hand-rolled version drops. The current code also needs the explicit `Exit.Exit<string, ConfigError>` annotation and the `return yield* result` re-raise; any future edit that moves a statement outside the mask, or forgets the re-raise, converts an interrupt into a success and wedges every deduped waiter on a Deferred nobody completes.

```ts
return yield* attempt.pipe(
  Effect.onExit((exit) =>
    Deferred.done(deferred, Exit.isInterrupted(exit)
      ? Exit.fail(ConfigError.MissingData([...path], `The prompt for %${name} was interrupted before an answer arrived`))
      : exit).pipe(Effect.zipRight(cleanup)))
);
```

Applied: typecheck/lint/189 green, including the `it.live` interruption test at `test/config.test.ts:345-403` — the exact guarantee at stake. `scope-in-layer-effect` is about `Scope` inside `Layer.effect`; nothing recognises a hand-rolled finalizer.

**`src/config.ts:171` — [MED] the counted `for` poll loop bounds *iterations*, not elapsed time, so the documented `promptTimeoutMillis` is not the actual deadline.**
`attempts = Math.max(1, Math.ceil(timeout / pollInterval))` counts sleeps only; each pass also pays a `readGlobal` and a `taskRunning` bridge call, so real elapsed time always *overshoots* — the direction that threatens the module's own invariant at `:24-27` (host action timeout must exceed the prompt timeout), and it makes the `"within ${timeout}ms"` message false. Degenerate inputs break it outright: `pollIntervalMillis: 0` makes `attempts` `Infinity` and the loop never terminates; `NaN` runs zero iterations. Commit `eb4884a` grew the loop rather than replacing it, so one hand-rolled `for` now carries a cadence, a divided budget, a mutable `seenRunning` flag, an early success and an early typed failure.

```ts
const pollOnce: Effect.Effect<string | undefined, ConfigError.ConfigError> = Effect.gen(function* () {
  yield* Effect.sleep(Duration.millis(pollInterval));   // keep the sleep in the body: preserves sleep-first ordering
  /* readGlobal → taskRunning → seenRunning → post-dismissal re-read → typed fail; unchanged */
});
return yield* pollOnce.pipe(
  Effect.repeat({ until: (v): v is string => v !== undefined }),
  Effect.timeoutFail({ duration: Duration.millis(timeout),
    onTimeout: () => ConfigError.MissingData([...path], `…not answered within ${Duration.format(Duration.millis(timeout))}`) })
);
```

Applied: typecheck/lint/189 green. **Do not** use the `Effect.repeat({ schedule, until })` form — `Repeat.Return` (Effect.d.ts:20598-20612) checks the `schedule` branch first, so the result type becomes the schedule's output (`number`), not the value; and composing `Effect.delay` with `Schedule.spaced` doubles the cadence. `global-timers-in-effect` targets `setTimeout`/`setInterval`; the code correctly uses `Effect.sleep`, so nothing fires.

**`src/sync/core.ts:43` — [MED] `decodeAs` + `getJson` hand-roll fetch-then-decode where `HttpClientResponse.schemaBodyJson` is the primitive.**
Verified historically: commit `b8a8f9f` ("schemaBodyJson") touched only `tasks/scripts/*` and tests, and `grep schemaBodyJson src/` returns nothing — so `core.ts` is the last split fetch/decode in the repo, while `morning-briefing.ts:42` already shows the target shape. The response is untyped `unknown` between the two steps and the URL is plumbed twice per call site (`:120/123`, `:160/163`).

```ts
const getSchema = <A, I>(schema: Schema.Schema<A, I>, url: string, token: string | undefined) =>
  client.get(url, { headers: apiHeaders(token) }).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    Effect.catchTags({ RequestError: …, ResponseError: …, ParseError: … })   // one place, three tags
  );
```

Applied: typecheck/lint/189 green, with behaviour preserved (status, decode and schema-mismatch messages identical). `decodeAs` and `getJson` both delete. `prefer-schema-over-json` matches `JSON.parse`/`stringify` call sites; the parse here happens inside `@effect/platform`.

**`scripts/compile-tasks.ts:88` — [MED] a hand-rolled edge runner (`Effect.runPromise` + `catchAllCause` + two exit-code writes + a trailing `.catch`) where `NodeRuntime.runMain` is the shipped primitive.**
Unlike `src/cli.ts`, whose `Promise<number>` shape is genuinely required by `bin/tasker-effect.mjs:17`, this is a build script. Three losses: the Cause is rendered by `defaultLogger` (logfmt), so a failed compile escapes the whole stack into one quoted field; there is no SIGINT/SIGTERM handling, so Ctrl-C never interrupts the fiber and the `Effect.scoped` around `PlatformCommand.start` in `detectRepoFromGit` never runs its finalizer; and the exit code has two owners.

```ts
NodeRuntime.runMain(main.pipe(Effect.provide(Layer.mergeAll(TaskerCompiler.Default, FileStore.Default, NodeContext.layer))));
```

Applied: typecheck/lint clean and `bun run compile` ran end-to-end with visibly pretty Cause output. The failure exit code is 1 either way. `run-effect-inside-effect` correctly stays silent — this run *is* at the top level.

**`src/sync/core.ts:165` — [MED] "newest artifact" is decided by `localeCompare` on a `Schema.String` timestamp, plus a sort-then-`[0]`-then-`undefined`-check dance.**
`Artifact.created_at` (`contract.ts:83`) is an ISO-8601 instant modelled as an opaque string, so the whole point of the function rests on ICU collation. It happens to be correct for GitHub's fixed-width UTC strings — the practical risk is low — but nothing in the type says the strings are fixed-width UTC, and the same `localeCompare` idiom is used for the release list. Effect ships both halves:

```ts
created_at: Schema.Date,                                        // contract.ts:83 — rejects an invalid date at decode
const live = response.artifacts.filter((a) => !a.expired);
if (!Arr.isNonEmptyReadonlyArray(live)) return yield* new NothingToSyncError({ … });
return Arr.max(live, Order.mapInput(Order.Date, (a: ArtifactInfo) => a.created_at));
// core.ts:200 — version: artifact.created_at.toISOString()
```

Applied: typecheck clean, 10/10 sync tests pass. `global-date` fires on `new Date()`/`Date.now()`, neither present.

**`src/compiler.ts:1116` — [MED] `secrets.json` ordering depends on ICU/locale via `localeCompare` instead of Effect's deterministic `Order.string`.**
This sort determines the bytes of a *release asset* the device downloads on every sync. Measured on this runtime: `"A_B".localeCompare("AB") === -1` while the code-point comparison `"A_B" < "AB"` is `false` — and `_` is admitted by the secret-name pattern (`profile.ts:91`), so `API_KEY` + `APIKEY` is a reachable pair that orders differently under full-ICU vs small-ICU Node or a non-default `LANG`. `Order.string` is `self < that ? -1 : 1` (`internal/Order.js:37`) — no ICU.

```ts
const bySecretName: Order.Order<Secret> = Order.mapInput(Order.string, (s: Secret) => s.name);
return Arr.sort([...byName.values()], bySecretName);
```

Applied: typecheck/lint/189 green — note the existing fixture (`test/compiler.test.ts:400`, ALPHA/ZEBRA) does not exercise the divergence, so add an underscore-bearing pair. No preset rule inspects sort comparators.

**`src/sync/node.ts:131` — [LOW] two byte-identical `pullLatestProfiles` wrappers hand-roll an accessor `Effect.Service` already generates, each restating the error union.**
The twin lives at `src/sync/tasker.ts:98`, differing only in the layer. A declared union can only ever drift *too wide*, forcing callers to handle variants the implementation can no longer produce, in two files that must move in lockstep.

```ts
export const pullLatestProfiles = (options: SyncOptions) =>
  ProfileSync.use((sync) => sync.pullLatestProfiles(options)).pipe(Effect.provide(SyncNodeLive));
```

Applied: typecheck/lint/189 green — remember to drop the now-unused type imports at `node.ts:29,34` or `--deny-warnings` fails. `unnecessary-effect-gen` targets a gen whose body is a single `yield*`; these have two.

**`src/sync/node.ts:70` — [LOW] `Effect.context` capture + per-call `Effect.provide` stands in for resolving `CommandExecutor` once.**
The round trip exists only because the free `Command.exitCode` re-requires the service on every call and the requirement then has to be erased to satisfy `extract`'s `R = never`. It also re-provides `FileSystem` on every call even though `fs` is already closed over.

```ts
const fs = yield* FileSystem.FileSystem;
const executor = yield* CommandExecutor.CommandExecutor;   // already imported
const exitCode = yield* executor.exitCode(Command.make("unzip", "-o", zipPath, "-d", targetDir));
// delete Effect.provide(context) at :100
```

Applied: typecheck/lint/189 green, layer's public type unchanged. `leaking-requirements` is satisfied either way — the manual erasure achieves what it wants, by a longer route.

**`src/cli.ts:269` — [LOW] mutable `let repo` closure memo where `Effect.cached` is the primitive.**
```ts
const resolveRepo = yield* Effect.cached(
  options.repo !== undefined ? Effect.succeed(options.repo) : detectRepoFromGit()
);
```
Applied: typecheck/lint/189 green; `yield* resolveRepo` at `:282` unchanged. The loop at `:279` is sequential today, so there is no live race — the value is idiom plus single-flighting if it is ever made concurrent. Behavioural delta worth noting: `Effect.cached` memoises failures too (unobservable here, since a `RepoDetectionError` aborts `compileEntry`).

**`src/runtime.ts:26` — [LOW] raw `try/catch` swallows where `Effect.try(...).pipe(Effect.ignore)` is the primitive.**
Both escape hatches — `tryFlash` and the `raw.exit()` block at `:55-59` — implement "run this, ignore any throw" with JS `try {} catch {}` in a module that otherwise models everything as Effects. The throws are real (`raw` is a proxy that throws `TaskerNotAvailableError`).

```ts
const tryFlash = (message: string) => Effect.try(() => raw.flash(message)).pipe(Effect.ignore);
Effect.ensuring(options?.exitWhenDone === true ? Effect.try(() => raw.exit()).pipe(Effect.ignore) : Effect.void)
```

`Effect.ignore` swallows exactly as the catch does — the gain is that the failure becomes a Cause one word from `Effect.ignoreLogged`. Fix alongside the `runtime.ts:48` reordering, which removes the need for `raw` entirely. `try-catch-in-effect-gen` is scoped to gen bodies; `catch-to-ignore` matches Effect combinators, not a JS `catch`.

**`src/config.ts:78` — [LOW] `parsePriority` hand-rolls string→int and silently accepts `"12abc"`.**
The doc comment promises "undefined for unset/garbage values", but `Number.parseInt("12abc", 10)` is `12` and passes both guards, so garbage becomes a live priority instead of the fallback.

```ts
const Priority = Schema.compose(Schema.NonEmptyString, Schema.NumberFromString).pipe(Schema.int(), Schema.nonNegative());
const parsePriority = Schema.decodeUnknownOption(Priority);   // (u: unknown) => Option<number>
```

Verified by running it: `none` for `"12abc"`, `"5.9"`, `""` and `undefined`; `some(7)` for `"7"`. Both pre-checks disappear. The code itself notes priority is "an optimization, not a correctness requirement", so this is consistency, not a bug. `prefer-typed-schema-decoder` only steers you once a Schema exists.

**`src/config.ts:110` — [LOW] the `Ref<Map<string, Deferred>>` single-flight registry duplicates `RcMap`, but no shipped primitive matches its semantics closely enough to be worth the migration.**
`Effect.cachedFunction` and `Cache` both retain the `Exit` forever, so a dismissed prompt would replay as an instant failure — a regression. `RcMap` does match on eviction (`idleTimeToLive` defaults to zero), but `RcMap.make` requires `Scope`, so the **exported** `makeTaskerConfigProvider` signature gains `Scope.Scope` and all ~18 call sites in `test/config.test.ts` need `Effect.scoped`, plus `Layer.unwrapEffect → unwrapScoped`. Verified that `RcMap` does *not* close the done/cleanup window (its refCount drops only when the acquirer's scope closes, after the failure has already propagated), so that argument for migrating is void. If the window is the concern, the one-line fix is to swap the two taps so `cleanup` runs before `Deferred.done`. Otherwise leave it and keep the existing dedup/interruption tests as the specification.

**`src/compiler.ts:1125` — [LOW] `secrets.json` is encoded by a hand-written field projection where `Schema.encodeSync` is the primitive.**
```ts
export const SecretManifest = Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String }));
export const compileSecretsJson = (project: Project): string =>
  `${JSON.stringify(Schema.encodeSync(SecretManifest)(collectProjectSecrets(project)), null, 2)}\n`;
```
Applied: typecheck/189 green, the exact-shape assertion at `test/compiler.test.ts:361-364` still passes (`encodeSync` drops `_tag`). **Do not sell this as drift protection** — renaming a `Secret` field already fails typecheck at `:1127`, and the two device-side consumers are emitted ES5 that cannot use a Schema either way. The value is a named, exported wire contract a test or third-party generator can decode against. `prefer-schema-over-json` demonstrably does not fire on this `JSON.stringify`.

---

## Modelling and API shape

**`src/compiler.ts:1095` and `:1175` — [MED] the compiler's only two `throw` sites hurl a `Schema.TaggedError` out of exported pure validators, and the linker stops at the first bad reference.**
`collectProjectSecrets` (`=> Array<Secret>`) and `checkTaskReferences` (`=> void`) are re-exported from the package root (`src/index.ts:167,169,170`), so consumers — and `test/compiled-output.test.ts:11`, which calls `compileProjectFiles` at *describe-collection* scope — get an exception the type never mentioned; a bad reference there aborts the whole file during collection instead of failing one named test. **Keep the pure synchronous API** (CLAUDE.md makes it explicit, and `tryCompile` already re-surfaces `CompileError` with its type intact), but batch the linker so one run lists every problem:

```ts
const bad: Array<string> = [];
// …push `${owner} references unknown task "${ref}"` instead of throwing…
if (bad.length > 0) throw new CompileError({ message: `${bad.join("; ")}. Valid targets: ${targetList}`, source: project.name });
```

Applied: typecheck clean, 189/189 (the existing assertions use `toContain`). Separately, move the `compileProjectFiles` call in `test/compiled-output.test.ts` inside a `beforeAll`/`it`. The `:1095` secrets conflict has nothing to accumulate — one name, one hard conflict — so first-wins there is fine. `try-catch-in-effect-gen` and `missing-effect-error` both need an Effect in scope; these are plain functions.

**`src/profile.ts:449` — [MED] `SetVolume.level` is a bare number, so volume-raising recipes cannot restore and the showcase profiles ratchet the user's volume permanently.**
`tasks/popular/driving.ts:26` sets media to 12 and the exit task (`:31-34`) restores only car mode and the flag; `media.ts:22` sets 9 on headset connect and never restores; `quiet.ts:31-32` and `media.ts:65` "restore" by writing hard-coded 5 and 30s over whatever the user had. The root cause is schema breadth: alone among value fields, `level` does not accept `Text`/`VariableRef`, so `Action.setVolume("media", v("SAVED_VOL"))` is inexpressible.

```ts
level: Schema.Union(Schema.Number.pipe(Schema.int(), Schema.nonNegative()), VariableRef, Secret, Interpolated),
// builder :1107-1109 takes number | Text; emit :258-260 becomes
`${typeof a.level === "number" ? a.level : emitText(a.level)}`   // emitText already yields global()/local()
```

Recipes then round-trip: `Action.setGlobal("%PREV_MEDIA_VOL", v("VOLM"))` on enter, `Action.setVolume("media", v("PREV_MEDIA_VOL"))` on exit. Independently, the two showcase profiles should restore what they raised. No rule inspects enter/exit symmetry or schema field breadth.

**`tasks/popular/driving.ts:49` — [MED] the `Action.js` escape hatch is justified by a false comment; the real gap is that `VariableRef` has no scope field.**
The comment at `:37-41` says raw JS is needed because "SendSms takes a literal number" — false: `SendSms.number` is `NonEmptyText` (`profile.ts:402`) and the builder takes `Text` (`:1096`), and the guard is expressible as `Action.when(cond("%DRIVING","eq","1"), …)`. The actual blocker is that `v("SMSRF")` would emit `global("SMSRF")`, wrong for Tasker's uppercase event-*local*. Because the workaround is a raw string, the compiler's secret/variable walk cannot see through it (`profile.ts:635`), so this entire class of event-driven recipe opts out of `secrets.json` collection and of Condition validation — and it is the template every future SMS recipe will copy.

```ts
export class VariableRef extends Schema.TaggedClass<VariableRef>()("VariableRef", {
  name: Schema.NonEmptyString,
  scope: Schema.optional(Schema.Literal("global", "local")),
}) {}
export const l = (name: string): VariableRef => new VariableRef({ name: variableName(name), scope: "local" });
// readVarExpr (compiler.ts:91) honours ref.scope first, falling back to isGlobalVariable
actions: [Action.when(cond("%DRIVING","eq","1"), [Action.sendSms(l("SMSRF"), "I'm driving right now…")])]
```

Do this together with the `isGlobalVariable` fix — the heuristic alone cannot separate a user global from an all-caps built-in local. Also correct the comment.

**`src/cli.ts:342` — [MED] `--repo` uses a second, incompatible slug parser: `owner/name.git` is accepted and baked into the device bootstrap URL.**
`parseGitHubRepo` (`:80-87`) strips a trailing `.git`; this regex allows `.` inside the name and does not. `--repo acme/automations.git` — the exact string copy-pasted from a clone URL — exits 0 and reaches `compiler.ts:665`, emitting `https://github.com/acme/automations.git/releases/download/…/sync-profiles.js` into the shipped project XML, so every first-run bootstrap 404s with no compile-time signal. `RepoRef` is the only domain type in the repo not modelled as a Schema.

```ts
const RepoRefFromString = Schema.transformOrFail(Schema.String, Schema.Struct({ owner: Schema.String, repo: Schema.String }), {
  strict: true,
  decode: (value, _o, ast) => { const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value.trim());
    return m === null ? ParseResult.fail(new ParseResult.Type(ast, value, "--repo requires <owner>/<name>"))
                      : ParseResult.succeed({ owner: m[1]!, repo: m[2]! }); },
  encode: (r) => ParseResult.succeed(`${r.owner}/${r.repo}`),
});
const repoOption = Options.text("repo").pipe(Options.withSchema(RepoRefFromString), Options.withDescription(…), Options.optional);
```

Applied: typecheck/lint/189 green; probe gives `acme/automations.git → {acme, automations}` and a rendered ValidationError for `nope`. The `throw new Error` inside `mapTryCatch` disappears too. Then route `parseGitHubRepo`'s tail through the same schema so the two cannot drift again. (`--repo` does **not** feed `%SYNC_OWNER`/`%SYNC_REPO` — those are hardcoded defaults in `sync-profiles.ts:29-30`; the blast radius is the bootstrap URL alone.)

**`src/profile.ts:1007` — [MED] every builder restates the `Schema.optionalWith` defaults the class constructor already applies.**
21 defaults are declared in the schemas and restated in the `Action`/`Trigger` factories (`:984-1270`). They agree today, so this is drift risk, not a bug — but the builder wins at runtime, so changing a schema default is a silent no-op, and nothing in typecheck, lint or the 189 tests catches divergence. The conditional spreads are unnecessary too: `optionalWith` without `exact: true` treats explicit `undefined` as absent.

```ts
say: (text, options?) => new Say({ text, stream: options?.stream, pitch: options?.pitch, speed: options?.speed,
                                   engine: options?.engine, voice: options?.voice }),
```

Verified on `Action.say`: typecheck clean, 189/189, and `Schema.encodeSync(Say)(Action.say("hi"))` byte-identical. Apply to the other builders. Keep `exactOptionalPropertyTypes: false`, which is what makes passing `undefined` typecheck. `prefer-unsafe-constructor`/`overridden-schema-constructor` are about construction mechanics, not wrappers restating defaults.

**`src/sync/contract.ts:156` — [LOW] `FileStoreShape` forces an always-failing `writeBytes` stub on Tasker, deferring a statically-known impossibility to after the zip download.**
Because `SyncTaskerLive` satisfies `ProfileSync` in full, the on-device service exposes `pullFromArtifacts`, which typechecks, downloads the whole artifact zip (`core.ts:190`) and only then dies at `files.writeBytes`. Splitting `writeBytes` into its own `BinaryFileStore` tag and moving `latestArtifact`/`pullFromArtifacts` into a separate service wired only into `SyncNodeLive` would remove the stub — but that is a breaking change across two public subpath exports plus the root barrel, and the current failure is at least a *typed* error, so nothing is laundered. Worth flagging as the stronger sibling of the same problem: `TaskerZipExtractor.extract` (`tasker.ts:69-71`) does `Effect.as([])`, i.e. it *succeeds* while discarding the real file list, so an on-device artifact sync silently returns `files: []`. Fail there instead: `ZipExtractError({ message: "extracted file list is not observable from Tasker", path: zipPath })`.

**`src/profile.ts:196` — [LOW] `NonEmptyText` is not a type-level distinction, so builders typed `Text` accept values the class rejects at runtime.**
`Schema.NonEmptyString` is a filter, not a brand, so `NonEmptyText.Type` and `Text.Type` are the same type; `Action.flash("")` typechecks and throws only at construction. There is also no exported `type NonEmptyText`, unlike `Text` (`:195`). Branding would force smart constructors at every call site and destroy the `Action.flash("hi")` ergonomics the DSL exists for, so the honest fix is: export the type alias, extend the doc comment at `:189-193` to say the check is construction-time only and why, and pin the behaviour with `expect(() => Action.flash("")).toThrow(ParseResult.ParseError)`. Separately tighten `Interpolated` (`:130`) so `new Interpolated({ parts: [""] })` — which satisfies `minItems(1)` and emits `""` — cannot fill a `NonEmptyText` field.

**`src/profile.ts:804` — [LOW] `BatteryLevelTrigger` validates each bound but not their relationship, so a reversed (never-active) range compiles into the setup README.**
`Trigger.batteryLevel(100, 20)` constructs happily and `describeTrigger` renders `State > Power > Battery Level from 100% to 20%` into the instructions the user copies into Tasker.

```ts
export class BatteryLevelTrigger extends Schema.TaggedClass<BatteryLevelTrigger>()("BatteryLevelTrigger",
  Schema.Struct({ from: …, to: … }).pipe(
    Schema.filter((t) => t.from <= t.to ? undefined : "battery range `from` must not exceed `to`"))) {}
```

Applied: typecheck/lint/189 green, `(100,20)` now throws, `(100,100)` and decode round-trips unaffected. **Do not** extend this to `TimeTrigger` — `quiet.ts:15` deliberately uses a 22:30→06:30 wrap-around, which is legitimate. No rule models cross-field invariants.

**`src/sync/node.ts:112` — [LOW] `Context.Tag` subclasses bolt on a fake `.Default` static, and the package exports two classes named `FileStore`.**
`Context.Tag` deliberately has no `.Default` — that static is `Effect.Service`'s marker, which also generates `make`, `use` and a memoised layer. The root exports the contract's `FileStore` (`index.ts:224`) while `tasker-effect/sync/node` exports a subclass of the same name; they interoperate only because Effect resolves by `key`. `ZipExtractor`'s copy is additionally dead — nothing in `src/`, `tasks/`, `scripts/` or `test/` imports it. Prefer importing the tag from the contract and the layer by its real name (`FileStoreNodeLive`), matching how `sync/tasker.ts` already names things; if the subpath is public API, keep `export const FileStore = FileStoreTag` as a deprecated alias for one release and drop the `ZipExtractor` subclass outright. `class-self-mismatch` validates `Effect.Service`/`Schema.TaggedClass` declarations, not `Context.Tag` subclassing.

**`src/config.ts:67` — [LOW] public option fields take raw millis where `Duration.DurationInput` is a strict superset.**
Every sink is a Duration sink (`Effect.sleep`, `Effect.timeoutFail`, `Duration.format`), and `DurationInput` already admits a bare number as millis, so accepting it lets callers write `"2 minutes"` without breaking numeric callers. Note this renames the fields (`promptTimeoutMillis` → `promptTimeout`), so it is a breaking change to `TaskerConfigOptions` and touches `test/config.test.ts:40`. Pure polish — the unit-arithmetic and machine-units-in-messages arguments no longer apply on this tree.

**`src/config.ts:109` — [LOW] the documented action-timeout invariant is per-key, but `Config` evaluation prompts strictly serially.**
`internal/configProvider.js:244-262` evaluates a Zip left-then-right and the other composites use `forEachSequential`; `Config` exposes no concurrency knob, and `withDefault` recovers each miss and continues. So N unanswered keys cost N × `promptTimeoutMillis`, and the stated condition ("action timeout > promptTimeoutMillis") is insufficient — the real one is "action timeout > unset-keys × promptTimeout". Both shipped scripts read 2 keys (240s worst case against 600s), so this is a **documentation** fix at `:24-27` and `:61-66`, not a timing change. **Do not** adopt a shared deadline captured at the first prompt: a user who spends 110s on key 1 would leave key 2 ten seconds, abandoning a dialog that is still on screen. If an aggregate cap is wanted, add an explicit `totalPromptBudgetMillis` that only short-circuits *before* issuing a new `performTask`.

---

## Device scripts (`tasks/`) — the least-reviewed code

**`tasks/scripts/morning-briefing.ts:39` — [MED] free-text config values are string-spliced into the query, and coordinates are read with `Config.string` where `Config.number` exists.**
`lat`/`lon` come from a free-text Tasker Input Dialog and are cached in a global forever, then spliced raw: `40,41` (comma decimal, the normal habit in the locale these defaults point at) produces `latitude=40,41`; a stray `&` injects a parameter. The only feedback is a generic "weather service returned 400" with the bad value still cached. Same at `adaptive-night-mode.ts:48/58-59`, where a wrong latitude yields *wrong sun times with no error at all*. Two independent halves:

```ts
const lat = yield* Config.number("HOME_LAT").pipe(Config.withDefault(40.41));   // Number("40,41") is NaN → InvalidData
client.get("https://api.open-meteo.com/v1/forecast",
  { urlParams: { latitude: lat, longitude: lon, current_weather: "true" } })     // UrlParams.Input percent-encodes
```

Verified against the installed source: `Config.number` is `Number(text)` + `isNaN` (not `parseFloat`, so `"40,41"` is rejected rather than truncated to 40), and `withDefault` only rescues `MissingData`, so a malformed stored global surfaces instead of shipping. Applied (both scripts, `fetchX` widened to `number`): typecheck/lint/189 green, `bun run compile` builds both bundles. Caveat to state in the commit: this is fail-fast, not self-healing — the bad value stays cached in the global. Optionally add `Config.validate({ validation: (n) => n >= -90 && n <= 90, message: … })`. No rule reasons about URL construction or which `Config` primitive fits a value.

**`tasks/scripts/adaptive-night-mode.ts:29` — [MED] `SunResponse` models sun times as bare strings, so an open-meteo format shift yields `NaN` and pins Night Mode off silently.**
The schema states none of the payload's real invariants: the array must be non-empty (hence the defensive `[0] === undefined` guard at `:64-71`) and each element must be a positional `YYYY-MM-DDTHH:MM` string (hence the two magic slice offsets in `hhmm`/`minutesOfDay`). If offsets shift, the payload still decodes, `minutesOfDay` returns `NaN`, both comparisons at `:84-85` are false, `isNight` is permanently false, and the only output is a cheerful "Night Mode disabled" every 30 minutes — routed around the `ParseError` handler at `:102` that exists to catch exactly this.

```ts
const LocalIsoTime = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/, { identifier: "LocalIsoTime" }));
const SunResponse = Schema.Struct({ daily: Schema.Struct({
  sunrise: Schema.NonEmptyArray(LocalIsoTime), sunset: Schema.NonEmptyArray(LocalIsoTime) }) });
```

Applied: `bun run compile` succeeds, 189/189 pass, and `daily.sunrise[0]` becomes non-optional so `:64-71` can be deleted **by hand** (TypeScript will not flag it as dead). Better still, replace `hhmm`/`minutesOfDay` with a `Schema.transform` to `{ hours, minutes }` so the arithmetic cannot produce `NaN`. The trigger is a hypothetical upstream change, not a live break — the realistic variation (polar `null`) is already rejected. `prefer-typed-schema-decoder` passes; the gap is *what the schema says*.

**`tasks/scripts/morning-briefing.ts:36` — [LOW] on-device HTTP calls have no deadline, so a hung request blocks `runInTasker`'s `exit()` finalizer.**
Both scripts run headless on a phone with a bare `FetchHttpClient`. `Effect.ensuring` (`runtime.ts:52`) cannot fire while a fetch is pending, and both file headers instruct disabling Auto Exit, so a stalled socket produces neither the success path nor the `catchTags` flash — nothing visible, repeating every 30 minutes for `adaptive-night-mode`.

```ts
Effect.flatMap(HttpClientResponse.schemaBodyJson(ForecastResponse)),
Effect.timeout(Duration.seconds(20)),
// + TimeoutException: () => tasker.flash("… weather request timed out") in the catchTags block
```

Applied with an optional `HttpClient.retryTransient({ times: 3, schedule: Schedule.exponential("500 millis") })`: typecheck/lint/189 green. The timeout is the half that buys something — a 5xx or DNS failure already lands in the `ResponseError`/`RequestError` branches and flashes a diagnostic, so only a genuinely hung socket is silent.

**`tasks/scripts/morning-briefing.ts:52` — [LOW] `orElseSucceed("")` + `parseInt`/`isNaN` funnels a typed `TaskerApiError` and an unset value into one sentinel path.**
Three outcomes — Tasker builtins missing, `%BATT` unset, `%BATT` non-numeric — collapse into one message, and the typed error is discarded before anything can see it. That loss is concrete: without the `orElseSucceed`, `runInTasker`'s `tapErrorCause` (`:49-51`) would have flashed it, so the swallow removes the only on-device visibility.

```ts
const batteryPart = yield* tasker.global("BATT").pipe(
  Effect.tapError((e) => tasker.flash(`Morning briefing: %BATT unreadable (${e.message})`)),
  Effect.flatMap(Schema.decodeUnknown(Schema.NumberFromString)),
  Effect.match({ onFailure: () => "Battery level unknown.", onSuccess: (l) => `Battery at ${l} percent.` })
);
```

The `tapError` is the load-bearing part. `catch-to-or-else-succeed` actively *recommends* the current shape, so the linter is pushing the wrong way here.

**`tasks/scripts/adaptive-night-mode.ts:87` — [LOW] the Effect script references the DSL profile by string literal while the DSL models the same reference nominally.**
`Action.enableProfile(profile: Profile, …)` (`profile.ts:1051`) takes the object and reads `.name`, with a separate untyped variant for the escape-hatch case; the script path has only the string. Rename the profile and the script calls a name that no longer exists, silently, every 30 minutes.

```ts
import { nightMode } from "../popular/quiet.js";
yield* tasker.enableProfile(nightMode.name, isNight);
```

Verified: `bun run compile` succeeds, 189/189, bundle stays free of `node:` specifiers. Cost the change carries: importing the DSL grows the bundle 486,265 → 494,614 bytes (+1.7%). It only becomes a *compile-time* guarantee once `tasks/` is typechecked — see the `tsconfig.json` finding.

---

## Test design and coverage

**`test/config.test.ts:40` — [MED] the prompt-path tests pin themselves to `it.live` with 5 ms stand-in timings, so the shipped 1s/120s budget is never exercised and three assertions are wall-clock races.**
The provider's timing surface is entirely Effect-native (`Effect.sleep` at `:184`), which is exactly what `TestClock` virtualises — the file's comment is right that it never auto-advances, but `fork` + `TestClock.adjust` drives it deterministically. Consequences: no test ever calls `makeTaskerConfigProvider(api)` without options on a prompting path, so the production defaults and the whole 120-attempt budget are dead in test; and `Effect.timeoutFail({ duration: "1 second" })` at `:197, :218, :280, :381` — the actual assertions for "fails promptly"/"waiter does not hang" — are load-sensitive CI flake. The interruption test at `:345` sequences fibers with hopeful 30 ms/10 ms sleeps.

```ts
it.effect("prompts via TE Config for a missing key and returns the answer", () => Effect.gen(function* () {
  const provider = yield* makeTaskerConfigProvider(api, { secrets: [API_KEY] });   // real 1s/120s
  const fiber = yield* Effect.fork(Effect.withConfigProvider(Config.string("OPENWEATHER_KEY"), provider));
  yield* TestClock.adjust("1 second");
  expect(yield* Fiber.join(fiber)).toBe("hunter2");
}));
```

Verified end to end, including an unanswered-prompt case asserting `isMissingDataOnly` after `TestClock.adjust("120 seconds")` — the first coverage of the shipped budget — and a deterministic rewrite of the interruption test (89 ms, no sleeps). Nothing in the preset models tester choice.

**`test/sync-tasker-bundle.test.ts:43` — [MED] the device-bundle guard hardcodes `sync-profiles.ts` while the build enumerates `tasks/scripts`, so three of four device entrypoints are unguarded.**
`scripts/compile-tasks.ts:46-48` discovers entrypoints dynamically, so CI bundles four scripts into `dist-tasker/` and attaches them to the release; the guard bundles one. The two newest scripts are precisely the ones widening the graph (both import `src/config.ts` and `@effect/platform`; one adds `DateTime`). The guard's coverage shrinks silently every time a script is added.

```ts
const entries = (yield* fs.readDirectory("tasks/scripts")).filter((n) => n.endsWith(".ts")).map((n) => path.join("tasks/scripts", n));
expect(entries.length).toBeGreaterThan(0);
yield* Effect.forEach(entries, (entry) => Effect.map(buildDeviceBundle(entry), (bundle) => {
  expect(bundle, entry).not.toContain("node:");
  expect(bundle, entry).not.toContain("@effect/platform-node");
}));
```

Applied: 2 tests, 885 ms, lint and typecheck clean; all four bundle cleanly today, so this is future coverage. `node-builtin-import` catches direct `node:*` imports — the uncovered case is a transitive one through `@effect/platform-node`.

**`test/support/valid-js.ts:7` — [MED] the shared JS-validity guard parses emitted code in *function-body* position, so a top-level `return` passes while being a SyntaxError under the `eval()` the compiler emits.**
Verified with a probe: `new Function("var x=1; if (x) { return; } flash('hi');")` parses, while `new vm.Script(...)` and `eval(...)` both throw `Illegal return statement`. Production evaluates at script level — `eval(source)` at `compiler.ts:602, 690, 810, 829`. A top-level `return` is the natural codegen for an early-exit guard, and `dispatcher.test.ts:118` documents that the scaffold check deliberately "never returns/exits before dispatch", i.e. the shape is one refactor away. This helper backs ~30 assertions.

```ts
// oxlint-disable-next-line effecttsgo/node-builtin-import -- tests are a sanctioned Node edge (CLAUDE.md)
import * as vm from "node:vm";
export const expectValidJs = (code: string, label?: string): void => {
  expect(code.trim().length, label).toBeGreaterThan(0);
  new vm.Script(code, { filename: label ?? "emitted.js" });   // compiles only; never runs
};
```

Applied: lint exit 0, 189/189. Pass `file.filename` as `label` from `compiled-output.test.ts:16`. (The assertion does *not* swallow the SyntaxError today — vitest prints it; the gain is the stricter parse position plus a filename in the trace.)

**`test/dispatcher.test.ts:229` — [MED] the three JS snippets embedded in the project XML are the only emitted code with no parse guard.**
The net covers every `.js` file, the dispatcher, the bootstrap and both config files — and misses exactly `configScanStubJs` (`compiler.ts:786`), `configLabelStubJs` (`:812`) and `configStoreJs` (`:830`), which are asserted only as escaped substrings. That is the inverse of the right risk ordering: XML-resident code cannot be hot-fixed, so a syntax error there bricks TE Config on every installed device until users delete the project, re-import a new XML and re-attach TE Dispatch (plus a `SCAFFOLD_VERSION` bump).

```ts
const payloads = [...xml.matchAll(/<code>129<\/code>\s*\n\s*<Str sr="arg0" ve="3">([\s\S]*?)<\/Str>/g)].map((m) => unescapeXml(m[1]!));
expect(payloads).toHaveLength(4);
for (const code of payloads) expectValidJs(code);
```

Verified against the live `taskerProjectXml()`: 4 scriptlets found, all parse today.

**`test/schema-annotations.test.ts:20` — [MED] the annotation test hand-maintains a third parallel member list instead of enumerating the schema's own members.**
This suite exists because `docs()` (`profile.ts:230-235`) is deliberately loosely typed, so it is the only validator of every `examples` annotation — but it validates only the 10 classes someone listed, a third list to keep in sync after the `Action` union and `actionMembers`. Add `docs({...})` to a new action tomorrow and nothing checks it. `typeSide` (`:33-36`) additionally hard-codes the list as its parameter type, making any widening a two-place edit.

```ts
for (const member of TriggerSchema.members) {
  const examples = SchemaAST.getExamplesAnnotation(typeSide(member.ast));
  if (Option.isNone(examples)) continue;                        // docs are opt-in
  it(`${member.name} is documented and its examples decode`, () => { /* description + decode each example */ });
}
```

Verified for the trigger half: the sweep enumerates 13 members, finds the 4 documented ones, all pass. The action half is blocked until `ActionSchema.members` is reachable — another reason to land the `profile.ts:793` refactor. Keep a `toBeGreaterThanOrEqual` count so an accidental annotation deletion still fails.

**`test/dispatcher.test.ts:34` — [LOW] three byte-identical redefinitions of the shared JS-validity guard bypass `test/support/valid-js.ts`.**
Same body including the suppression comment, at `dispatcher.test.ts:34`, `dispatcher.test.ts:125` (`expectValidSnippetJs`, ~90 lines from the first copy in the same file) and `sync-tasker-bundle.test.ts:27` (`expectParsesAsPlainJs`). Commit `b8a8f9f` introduced the shared guard and four of five call paths bypass it. Concrete cost: the script-level parse fix above would land on the compiler tests and miss the dispatcher and bundle guards — the two covering code Tasker actually `eval`s. Delete all three and `import { expectValidJs } from "./support/valid-js.js"`.

**`test/compiled-output.test.ts:15` — [LOW] vacuously-green JS-validity guards: an empty file list registers no tests, and `?? ""` passes an absent file.**
The suite's stated job is global enforcement over whatever `tasks/automations.ts` grows to contain, but it enforces nothing when the filter is empty — if `compileProjectFiles` ever stops emitting `.js`, the file reports zero tests and stays green. `compileProjectFiles` also runs at collection scope (`:11`), so a `CompileError` is a vitest crash with no failing test name. Same shape at `popular.quiet-driving.test.ts:85`: `expectValidJs(enter?.content ?? "")` passes when the file is missing, since `new Function("")` parses.

```ts
const jsFiles = files.filter((f) => f.filename.endsWith(".js"));
it("emits at least one compiled JS file", () => expect(jsFiles.length).toBeGreaterThan(0));
// quiet-driving:85 → expect(enter).toBeDefined(); expectValidJs(enter!.content);
```

**`test/cli.test.ts:196` — [LOW] seven subprocess-spawning CLI tests run under `it.effect`/`it.scoped`, installing a `TestClock` over real wall-clock process work.**
Six tests plus one `it.scoped` fork a real `bun` process, drain two stdio streams and await an OS exit code under a virtual clock. It passes only because nothing on the `Command.start`/`Stream.decodeText` path schedules an `Effect.sleep` — an implementation detail of platform-node, not a property of the test. The suite already draws this distinction correctly in `test/config.test.ts:42-44`. Swap to `it.live` (and `it.scopedLive` for `:249`, which needs a real clock *and* a Scope), keeping the existing 30_000 timeouts. Applied: 189/189, lint clean. Leave the three in-process `it.scoped` tests at `:80, :124, :138` alone.

**`test/profile.test.ts:80` — [LOW] seven schema-construction tests assert only `toThrow()`, so any incidental throw satisfies them and no constraint is pinned.**
`profile.test.ts:80, 81, 82, 139, 143, 147` and `compiler.test.ts:287`. Confirmed the real failure is a `ParseResult.ParseError`; a bare `toThrow()` is equally satisfied by a `TypeError` from a refactored builder, and `Trigger.batteryLevel(0, 150)` passes just as well if the `0-100` bound is replaced by a missing-field error. The same file already does it right at `:170`.

```ts
expect(() => Action.vibrate(-5)).toThrow(ParseResult.ParseError);
// where the specific bound is the point:
const r = Schema.decodeUnknownEither(BatteryLevelTrigger)({ _tag: "BatteryLevelTrigger", from: 0, to: 150 });
if (Either.isLeft(r)) expect(ParseResult.ArrayFormatter.formatErrorSync(r.left)[0]?.path).toEqual(["to"]);
```

Do **not** use `assertLeft` — it deep-equals against an expected left value and cannot express "a ParseError on this path".

**`test/compiler.test.ts:473` — [LOW] hand-rolled `try/catch` plus an `as CompileError` cast where the same file uses `toThrow(CompileError)` and the service + `Effect.flip` elsewhere.**
`let error: unknown` … `(error as CompileError).message` at `:480` reintroduces the exact type hole the error schema removes, and test/ is not covered by `bun run typecheck`. The four `toContain` assertions at `:481-484` grep the message prose for four separate facts, so rewording breaks the test while a genuinely wrong owner name would not. Minimum: `expect(() => compileProjectFiles(project, { repo: TEST_REPO })).toThrow(CompileError)` (matching `:356`). Better: add `owner`/`missingTask`/`validTargets` as optional fields on `CompileError` — no signature changes — and assert through the service with `Effect.flip`, as the adjacent test at `:486` already does.

**`test/compiler.test.ts:535` — [LOW] the hand-maintained action/trigger sample lists could be derived from the schema unions.**
`oneOfEveryAction` (41 entries) and `oneOfEveryTrigger` (13) are in sync with the runtime unions today by luck of review, in a describe block named "Match coverage" — while three lines below, `for (const op of ConditionOp.literals)` derives correctly from the schema. This is defence-in-depth rather than the guard it claims: `emitAction`'s `Match.exhaustive` already makes adding a class to *both* `actionMembers` and `Action` a hard typecheck error, so the only way a missing sample goes green is the `actionMembers`-only desync — i.e. the `profile.ts:793` cast. Fix that first; then, as cheap insurance, export the member tuples and `expect(actionMembers.map((m) => m._tag).filter((t) => !covered.has(t))).toEqual([])`. Note `triggerMembers` does not exist yet — `TriggerSchema` (`:916`) is an inline union.

**`test/popular.quiet-driving.test.ts:100` — [LOW] the README assertion is self-referential, so it only checks profile inclusion, not the trigger prose.**
`compileProjectFiles` builds the README by calling `describeTrigger` on these very triggers, so the assertion is `f(x) contains f(x)` and `toContain("")` would pass. Pin the literal instead: `expect(readme?.content).toContain("- Event > Phone > Received Text (Type: Any)")`. Polish only — a `describeTrigger` regression is already caught by `test/compiler.test.ts:602-604` and `:634-646`, and the one thing the current assertion uniquely buys is that a section was emitted at all.

**`test/schema-annotations.test.ts:49` — [LOW] the `schema as Schema.Schema<unknown>` cast can be removed by typing the table.**
Not gratuitous — removing it alone gives TS2345, because `documented` is an `as const` tuple and the union of class constructors collapses during inference. Annotating instead works:

```ts
const documented: ReadonlyArray<Schema.Schema.AnyNoContext & { readonly name: string }> = [ … ];  // drop `as const`
const decode = Schema.decodeUnknownSync(schema);                                                  // no cast
```

Verified: typecheck clean, 189/189. Keep `decodeUnknownSync` — swapping to `Schema.validateSync` fails 10 tests, because a `TaggedClass`'s Type side is the class instance while every `examples` annotation is a plain object literal (Encoded-side). `unsafe-effect-type-assertion` misses this for the same reason it misses `profile.ts:793`.

**`tsconfig.json:26` — [LOW] `bun run typecheck` covers only `src/`, so `test/`, `tasks/` and `scripts/` get no TypeScript diagnostics in CI.**
Confirmed with `tsc --listFilesOnly`: nothing outside `src/` enters the program, and vitest transpiles with esbuild without checking. The only feedback those directories get is oxlint's type-aware pass — the ~90 Effect rules, not TypeScript's own diagnostics. So the casts noted above go unexamined, and both shipped device bundles are compiled by `Bun.build` with no `tsc` over them at all.

```jsonc
// tsconfig.test.json
{ "extends": "./tsconfig.json", "compilerOptions": { "noEmit": true, "rootDir": "." },
  "include": ["test/**/*", "tasks/**/*", "scripts/**/*", "examples/**/*"] }
// package.json → "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.test.json"
```

Verified: the second project exits 0 on the current tree, so it lands with no cleanup pass. The base config keeps `rootDir`/`outDir`, so `bun run build`'s emit surface is untouched.

---

## Minor

**`src/compiler.ts:179` — [LOW] `opt()` emits the literal identifier `undefined` for omitted optional Tasker arguments instead of shortening the call.**
Verified: `Action.say("hi")` → `say("hi", undefined, undefined, "media", 5, 5)`; `Action.performTaskerTask("Manual")` → `performTask("Manual", 5, undefined, undefined)`. The bindings declare these optional with in-app defaults, which are bypassed. Whether the Java bridge coerces `undefined` to null or to the string `"undefined"` cannot be checked from this repo — which is the point: the trailing case is a gratuitous risk with a provably safe fix (fewer arguments is the documented default path). Add a trailing-hole trimmer and use it for `PerformTask` (`:210`) and `PerformTaskerTask` (`:213`) only — it does **not** help `sendIntent` (trailing arg is the `[]` extras) or `loadApp` (trailing arg is a boolean). Interior holes (`say`'s engine/voice) still need a value; confirm on a device before touching those.

**`src/cli.ts:114` — [LOW] `String(cause)` discards `PlatformError`'s `reason`, and `gitOriginRemote` never drains stderr.**
`reason === "NotFound"` — git not on PATH, a common state in a CI container — is the one case the CLI could act on, and it reads identically to a permission error; `runCli` then appends "Pass --repo …" for every case. Separately, when git *does* run and exits non-zero, its actual message (`error: No such remote 'origin'`) is discarded and only the numeric exit code is reported.

```ts
const [output, stderr, exitCode] = yield* Effect.all(
  [process.stdout.pipe(Stream.decodeText(), Stream.mkString),
   process.stderr.pipe(Stream.decodeText(), Stream.mkString), process.exitCode], { concurrency: 3 });
// then: cause._tag === "SystemError" && cause.reason === "NotFound" ? "`git` was not found on PATH…" : `… ${cause.message}`
```

Applied: typecheck/lint clean, 23/23 CLI tests pass. `catch-all-to-map-error` is already satisfied; no rule inspects what a mapping function discards.

**`src/compiler.ts:175` — [LOW] `emitAction`'s Match chain is split across three `.pipe` calls with a comment stale on both the split count and the tag count.**
The split is **safe** — the Matcher's `Remaining` threads across `.pipe` boundaries, so `Match.exhaustive` still closes the union and adding an action tag breaks the build here. The costs are modest: the comment says "two .pipe calls" (there are three, at `:181, :253, :282`) and "35 tags" (there are 41); the partition is a pipe-arity artefact, so `SetWifi` and `SetBluetooth` sit in different segments and every new tag is placed by counting; and it costs a permanent `unnecessaryPipeChain:off` suppression. Cheapest fix, worth doing regardless: correct the comment. The mapped handler table (`{ [K in Action["_tag"]]: … }`, the shape already used for `VOLUME_FN` at `:158-167`) removes the split and the suppression, at the price of one contained `as` at the dispatch site — verified required, TS reduces the parameter to `never` otherwise.

---

## Deliberate and fine — do not fix these

**CLAUDE.md constraints.** Effect 3.22 rather than the 4.x beta; no XML for compiled logic (the one sanctioned `tasker-effect.prj.xml` scaffold excepted); no bundling in the CLI; no Node APIs in on-device code; `@effect/platform-node` confined to `src/sync/node.ts`, `src/cli.ts`, `scripts/` and tests; the structural (not tree-shaken) `sync/node` vs `sync/tasker` subpath split; and — importantly for two findings above — **`compileTaskToJs`/`compileProjectFiles` staying pure synchronous functions**. Do not convert the compiler's public API to `Either`- or `Effect`-returning; `tryCompile`'s `Effect.try` around a throwing pure core is the sanctioned seam and it preserves the typed `CompileError` verbatim. The remaining defect in that area is `tryCompile`'s *catch-all* branch and the fabricated channels on `compileTask`/`compileProfile`, reported separately.

**`effecttsgo/instance-of-schema` disabled.** `instanceof Task/Profile/Project` in the compiler and CLI is the intended nominal check, with a written justification in `.oxlintrc.json`. Never flagged.

**Emitted on-device JS.** The ES5 string literals the compiler produces are plain by design; only the compiler code choosing what to emit was audited. The `Object.entries`/`hasOwnProperty` style in `dispatcher.js`, the lack of `const`, etc. are all deliberate.

**Refuted on the current tree.** The `Condition` op/value coupling — `cond(x, "eq")` with no value compiling to `=== ""` — **no longer exists**: commit `dadd35a` modelled `Condition` as `Schema.Union(Comparison, Presence)` with a required `value` on the comparison side and none on the presence side, `cond` taking a discriminated rest-tuple union (`CondArgs`) so the operator/value pairing is a compile error rather than a `ParseError`, and `conditionExpr` now matches the whole condition with `Match.exhaustive`, so the `?? ""` and its always-true `new RegExp("")` are gone. Also refuted: replacing the config prompt registry with `Effect.cachedFunction`/`Cache` (both memoise failures forever, so a dismissed prompt would never re-prompt) and the claim that its interruption branch is untested (`test/config.test.ts:346` covers it precisely); deriving `ActionEncoded` from the union (circular through `If`'s `Schema.suspend` — only the split-tuple form works); `Effect.repeat({ schedule, until })` returning the polled value (it returns the schedule's output); `HttpClient.retryTransient`'s defaults covering GitHub rate limits (403 is not in the transient set, and adding a retry breaks `test/sync.test.ts:226` under `TestClock` unless the schedule is injectable); and the claim that lowering the scaffold's 600s action timeout would pass CI (`test/dispatcher.test.ts:161` pins it — only the config-side 120s default is unexercised).