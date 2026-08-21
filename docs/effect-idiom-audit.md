# Effect-3.22 Idiom Audit — tasker-effect

All APIs below were verified against the installed typings (`effect` 3.22.1, `@effect/platform` 0.97.1, `@effect/platform-node` 0.108.1, `@effect/cli` 0.77.0). Line numbers are 1-indexed against the current tree.

## Top 5 highest-leverage fixes

| # | Fix | Why | Effort |
|---|-----|-----|--------|
| 1 | `src/profile.ts:632` — delete the `as unknown as` on `ActionSchema`; derive `Action`/`ActionEncoded` from the member list | The only place in the repo where a Schema's static type is severed from its runtime value; also degrades a public wire type to `Record<string, unknown>`. Verified: after the change, adding a member without an `emitAction` case fails `tsc` instead of throwing a MatchError at codegen time. | M |
| 2 | `src/compiler.ts:941 / :1013 / :1101` — return `Either` from the two pure validators, then delete `tryCompile` | Today a genuine defect (TypeError in the emitter) is flattened by `String(cause)` and printed to the user as a compilation error, stack and cause discarded. Must land as one change, in this order. | M |
| 3 | `tsconfig` typecheck gap + `test/cli.test.ts:98` — add a `typecheck:all` config covering `test/ tasks/ scripts/ examples/`, drop the redundant `as Effect.Effect<A, E>` | `include` is `["src/**/*"]`, so CI never sees test code; a real pre-existing error already rots there (`test/tasker-api.test.ts:136`). The cast erases the R channel for no reason. | S |
| 4 | `src/tasker-api.ts:685-698` — wrap `makeTestTasker`'s recorder in `Effect.suspend` | The test double records at construction while `liveFn` is execution-lazy; every `expect(calls).toHaveLength(n)` silently rests on "built once == ran once". No test changes needed. | S |
| 5 | `src/sync/tasker.ts:61,82` — drop `Layer.provide(Tasker.Default)` from the capability layers | `SyncTaskerLive` is `Layer<ProfileSync>` with `RIn = never`, so the recording Tasker can never be substituted — which is why the entire on-device sync module has zero behavioural tests. | S |

---

## 1. Errors as exceptions (compiler)

**`src/compiler.ts:1101` — [HIGH] `tryCompile` launders defects into `CompileError` via `String(cause)`.**
Everything that is not already a `CompileError` — a `TypeError` in the emitter, a bad property access — is flattened to a one-line string and printed by `runCli`'s `CompileError` handler (`src/cli.ts:440`) as if the user's project were at fault. Stack, cause and `Cause.Die` reporting are all lost.

```ts
// after — once findings below land, delete tryCompile entirely
compileProject: (project, options) =>
  Effect.suspend(() => compileProjectFiles(project, options)) // Either is assignable to Effect
```
If a defensive boundary is still wanted, keep it but preserve the cause: add `cause: Schema.optional(Schema.Defect)` to `CompileError` (`Schema.d.ts:4549`) and print it from the CLI handler. Do **not** remove `tryCompile` before the two throws below are converted.

**`src/compiler.ts:1013` — [MED] `checkTaskReferences` is `=> void` and signals linker failures only by throwing; it also stops at the first bad reference.**
`compileProjectFiles` calls it for its side effect at `:1036`, so nothing in the type system records that the compiler's most important validation can fail, and users fix unknown task refs one recompile at a time.

```ts
// after
const checkTaskReferences = (project: Project): Either.Either<void, CompileError> => {
  const targets = project.tasks.map((t) => t.name);
  const owned = [ /* profiles' enter/exit + tasks, as the current function walks them */ ];
  const bad = owned.flatMap(({ owner, task }) =>
    collectTaskRefs(task.actions)
      .filter((ref) => !targets.includes(ref))
      .map((ref) => `${owner} references unknown task "${ref}"`)
  );
  return Arr.isNonEmptyReadonlyArray(bad)          // Array.d.ts:927
    ? Either.left(new CompileError({ message: `${bad.join("; ")}. Valid targets: …`, source: project.name }))
    : Either.void;                                  // Either.d.ts:106
};
```
Keep the message fragments (`Profile "…"`, `unknown task "…"`, `Valid targets: …`) so `test/compiler.test.ts:456-462` still passes; only the `try/catch` wrapper at `:452` becomes an `Either.isLeft` check.

**`src/compiler.ts:941` (fn at `:929`) — [MED] `collectProjectSecrets` is typed `=> Array<Secret>` but throws on a duplicate-description conflict.**
It is a public export (`src/index.ts:159`) whose total signature hides a failure; `compileSecretsJson` (`:971`) and `compileProjectFiles` (`:1036`) call it with no indication they can blow up. The throw sits inside a `(secret) => void` visitor, so accumulate and return afterwards.

```ts
// after
export const collectProjectSecrets = (
  project: Project
): Either.Either<Array<Secret>, CompileError> => {
  let conflict: CompileError | undefined;
  // …existing walk, replacing `throw` with `conflict ??= new CompileError({…})`…
  return conflict !== undefined
    ? Either.left(conflict)
    : Either.right([...byName.values()].sort(/* see §2 */));
};
```
`compileSecretsJson` becomes `Either.map(collectProjectSecrets(project), …)`. Breaking change to two public exports; update `test/compiler.test.ts:335` from `.toThrow(CompileError)` to `Either.isLeft`.

Keep these three functions **pure** — CLAUDE.md pins the codegen path to pure functions, and `Either` is the pure-failure construct. Do not convert them to `Effect`.

---

## 2. Schema type-safety & unvalidated invariants

**`src/profile.ts:632` — [HIGH] `ActionSchema`'s `as unknown as` severs the union's runtime type from its declared type.**
Two drifts become invisible: a class added to `actionMembers` but not to `Action` (line 552) decodes fine and then dies on `Match.exhaustive` in `emitAction` (`src/compiler.ts:286`); a class added to `Action` but not to `actionMembers` typechecks and then throws a ParseError inside `new Task({…})`. The cast exists only because `ActionEncoded` (`:591`) is a hand-written `{ _tag: string } & Record<string, unknown>` — which is also exported publicly (`src/index.ts:115`).

```ts
// after — verified: typecheck clean, 121/121 tests pass, no cast
const leafMembers = [Flash, Popup, /* …34 leaves, order unchanged… */ JavaScript] as const;
type LeafAction = Schema.Schema.Type<(typeof leafMembers)[number]>;
type LeafActionEncoded = Schema.Schema.Encoded<(typeof leafMembers)[number]>;

export interface IfEncoded {
  readonly _tag: "If";
  readonly condition: Schema.Schema.Encoded<typeof Condition>;
  readonly then: ReadonlyArray<ActionEncoded>;
  readonly orElse?: ReadonlyArray<ActionEncoded> | undefined;
}
export type Action = LeafAction | If;
export type ActionEncoded = LeafActionEncoded | IfEncoded;
const actionMembers = [...leafMembers, If] as const;
export const ActionSchema: Schema.Schema<Action, ActionEncoded> = Schema.Union(...actionMembers);
```
Keep the `If` class's `Schema.suspend((): Schema.Schema<Action, ActionEncoded> => ActionSchema)` annotations verbatim — they are what resolves the recursion. Consider re-exporting `IfEncoded` next to `ActionEncoded`.

**`src/profile.ts:721-743` — [MED] `Trigger` union is hand-maintained in parallel with `TriggerSchema`.**
Nine classes listed twice with nothing tying them together; drift dies on `Match.exhaustive` in `describeTrigger` (`src/compiler.ts:366`) or inside `new Profile({…})`. No recursion here, so no hand-written type is needed.

```ts
// after — verified: typecheck clean, 121/121; adding a 10th schema member now fails tsc at compiler.ts:366
export const TriggerSchema = Schema.Union(TimeTrigger, /* … */ StateTrigger);
export type Trigger = typeof TriggerSchema.Type;
```

**`src/profile.ts:280` — [MED] `SetLocal.name` is an unvalidated `NonEmptyString`, so `%`-prefixed names reach the emitted JS.**
Only the builder strips `%`; `emitAction` re-normalizes `SetGlobal` but not `SetLocal` (`src/compiler.ts:185-187`). Reproduced: decoding `{_tag:"SetLocal", name:"%foo", value:"bar"}` — a live path, `src/cli.ts:151,171` feeds plain objects through `Schema.decodeUnknownEither(Task)` — emits `setLocal("%foo","bar")`.

```ts
// after — verified: typecheck clean, 121/121, zero test edits
const BareVarName = Schema.NonEmptyString.pipe(Schema.pattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
export const TaskerVarName = Schema.transform(Schema.String, BareVarName, {
  strict: true,
  decode: (s: string) => (s.startsWith("%") ? s.slice(1) : s),
  encode: (s: string) => s,
});
// :280  name: TaskerVarName
// :204  export const VarName = Schema.Union(TaskerVarName, Secret);  // also buys char validation
```
`VariableRef.name` is *not* affected — `readVarExpr` (`src/compiler.ts:85-88`) already strips `%` on every path.

**`src/profile.ts:217` — [MED] `Condition`'s `op`/`value` coupling is unvalidated, so `cond("BATT","lt")` compiles to `parseFloat(global("BATT")) < parseFloat("")` — always false, no error anywhere.**
`conditionExpr` does `condition.value ?? ""` (`src/compiler.ts:136`). `op: "matches"` likewise feeds an unvalidated pattern into `new RegExp(...)` (`:145`), discovered only as a toast on the phone.

```ts
// after — verified: `new Condition({variable:"X", op:"lt"})` throws "lt" requires a comparison value
export class Condition extends Schema.Class<Condition>("Condition")(
  Schema.Struct({ variable: VarName, op: ConditionOp, value: Schema.optional(Schema.String) }).pipe(
    Schema.filter((c) => {
      if (c.op === "isSet" || c.op === "notSet")
        return c.value === undefined ? undefined : `"${c.op}" takes no comparison value`;
      if (c.value === undefined) return `"${c.op}" requires a comparison value`;
      if (c.op === "matches") { try { new RegExp(c.value); } catch { return `"${c.value}" is not a valid regular expression`; } }
      return undefined;
    })
  )
) {}
```
Companion edit required: `test/compiler.test.ts:576-579` loops every `ConditionOp` literal with a value and will throw — split into comparison-op and valueless-op loops.

**`src/profile.ts:797-1033` — [MED] builders restate ~19 defaults their schemas already declare via `Schema.optionalWith`.**
`Flash.long` is defaulted at `:230` and re-stated at `:798`; same for `popup` (`:807` vs `:237`), `say` (`:822` vs `:250`), `performTask`/`performTaskerTask` priority (`:842`,`:855` vs `:300`,`:316`), `shell` (`:880` vs `:342`), `http` (`:902` vs `:374`), `setVolume` (`:928` vs `:436`), `musicPlay` (`:942` vs `:451`), `getLocation` (`:989` vs `:521`), `Trigger.wifiConnected`/`bluetoothConnected` (`:1032` vs `:665`,`:673`), `Trigger.time` (`:1024` vs `:647`). Builder and decode paths can silently fork.

```ts
// after — verified on flash/say: typecheck clean, 121/121
flash: (text: Text, options?: { readonly long?: boolean }) => new Flash({ text, ...options }),
```
Keep an explicit spread only where the builder *transforms* (`asVarName(options.outputGlobal)`, `new TimeOfDay(...)`, `taskName: task.name`).

**`src/profile.ts:130` — [LOW] `Interpolated.parts` uses `Schema.Array(...).pipe(Schema.minItems(1))` where `Schema.NonEmptyArray` carries the invariant in the type.**
No live bug (the class constructor already rejects `[]`), but `Task.actions` (`:752`) already uses the right constructor.

```ts
// :130  parts: Schema.NonEmptyArray(TextPart),
// in fmt (~:181), the sole producer:
if (!Arr.isNonEmptyReadonlyArray(parts)) return "";   // behaviour-preserving: all-literal empty template
```

**`test/cli.test.ts:98` — [MED] redundant cast erases the R channel after `Effect.provide`.**

```ts
// after — verified unnecessary: tsc over src/+test/ is unchanged without it
const run = <A, E>(effect: Effect.Effect<A, E, TaskerCompiler | FileStore | NodeContext.NodeContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(CliTestLayer)));
```
Fix the enforcement gap at the same time: `tsconfig.json`'s `include` is `["src/**/*"]`, so `bun run typecheck` never inspects `test/`, `tasks/`, `scripts/` or `examples/`. Add `tsconfig.all.json` (`noEmit`, repo-root `rootDir`, those globs) and a `typecheck:all` script — it immediately surfaces a real error nobody sees today at `test/tasker-api.test.ts:136` (`string` passed where the action-name union is required).

**`src/compiler.ts:971` — [LOW] `secrets.json`'s wire shape has no Schema.**
Three parties depend on it (this emitter, `configScanJs`/`configLabelJs`, tests), and `test/compiler.test.ts:394` annotates plain `{name, description}` objects as `Secret`.

```ts
export const SecretsManifest = Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String }));
const encodeManifest = Schema.encodeSync(Schema.parseJson(SecretsManifest, { space: 2 }));
// output verified byte-identical to JSON.stringify(..., null, 2); keep the trailing "\n" outside the encoder
```
The payoff is the exported decoder for the test, not the encoder.

**`src/sync/contract.ts:83` / `:70` — [LOW] `created_at` and download URLs are `Schema.String`.**
`Schema.DateTimeUtc` (`Schema.d.ts:3631`) + `DateTime.Order` (`DateTime.d.ts:262`) would replace the `localeCompare` comparator at `src/sync/core.ts:170`; `Schema.URL` (`Schema.d.ts:2663`) is directly usable since `HttpClient.get` takes `string | URL`. Neither is a reachable bug — GitHub's payloads are Z-normalised and absolute — and both change public types on `ArtifactInfo`. Note `DateTime.formatIso` normalises to millisecond precision, so `SyncResult.version` text changes.

---

## 3. Layers, services & test seams

**`src/sync/tasker.ts:61, :82` — [MED] capability layers self-provide `Tasker.Default`, closing the only substitution seam.**
`SyncTaskerLive` is `Layer<ProfileSync>` with `RIn = never`, so `makeTaskerTestLayer().layer` can never be injected — hence zero behavioural coverage of the on-device sync module, while `sync/core.ts` is thoroughly tested through swappable `Layer.succeed(FileStore, …)` stubs.

```ts
// after — drop `.pipe(Layer.provide(Tasker.Default))` from both, and:
export const SyncTaskerLive: Layer.Layer<ProfileSync, never, Tasker> = …
// MUST also update the one-shot at :98, or the build fails TS2322:
export const pullLatestProfiles = (options: SyncOptions): Effect.Effect<SyncResult, …, Tasker> => …
```
Verified: with that annotation, full-tree `tsc` is clean and 121/121 tests pass; `tasks/scripts/sync-profiles.ts:40` needs no change (`runInTasker` accepts `Effect<A, E, Tasker>`). The duplicate `Tasker` instances themselves are harmless — the service is a stateless facade (`src/tasker-api.ts:645`).

**`src/runtime.ts:46-64` — [MED] `Effect.provide(Tasker.Default)` is applied *before* the handlers, forcing the `raw` proxy and bare `try/catch`.**
The `tapErrorCause`/`ensuring` handlers run outside the provided context, so they fall back to `raw.flash`/`raw.exit` wrapped in `catch {}` — re-implementing, untyped, what `liveFn` (`src/tasker-api.ts:608-624`) already does as typed failures.

```ts
// after — verified: passes bun run typecheck; tryFlash and both try/catch blocks disappear
program.pipe(
  Effect.tapErrorCause((cause) =>
    Tasker.pipe(Effect.flatMap((t) => t.flash(`tasker-effect: ${Cause.pretty(cause)}`)), Effect.ignoreLogged)
  ),
  Effect.ensuring(
    options?.exitWhenDone === true
      ? Tasker.pipe(Effect.flatMap((t) => t.exit()), Effect.ignore)
      : Effect.void
  ),
  Effect.provide(Tasker.Default)
)
```
Use `ignoreLogged` for flash (a real `TaskerCallError` is currently lost), plain `ignore` for exit. Note this does not make a throwing `exit()` any less fatal — it only makes the cause visible.

**`src/sync/node.ts:133` & `src/sync/tasker.ts:98` — [MED] byte-identical one-shot wrappers re-implement the generated `ProfileSync.use` accessor.**
The same `Effect.gen(function*(){ const sync = yield* ProfileSync; return yield* sync.X(...) })` shape appears 9 more times in `test/sync.test.ts`.

```ts
// after — KEEP the explicit return annotation
export const pullLatestProfiles = (
  options: SyncOptions
): Effect.Effect<SyncResult, GitHubApiError | DownloadError | NothingToSyncError | StorageWriteError> =>
  ProfileSync.use((sync) => sync.pullLatestProfiles(options)).pipe(Effect.provide(SyncNodeLive));
```
Dropping the annotation changes the public success type from `SyncResult` to an inferred literal-narrowed shape with a **mutable** `string[]`, which lands in the emitted `.d.ts`. `accessors: true` on the `Effect.Service` call (`src/sync/core.ts:57`, option at `Effect.d.ts:26488`) would collapse the 9 test gen-blocks to `ProfileSync.pullLatestProfiles(opts).pipe(Effect.provide(layer))`.
Related [LOW]: because `Effect.provide` builds a fresh MemoMap per call, repeat calls to these wrappers rebuild the whole layer stack. Nothing in-repo calls them (`sync-profiles.ts:32-40` already resolves `ProfileSync` under its own provide), so add an un-provided sibling only if you want it.

**`src/sync/node.ts:70-72, :102` — [LOW] `Effect.context` captured at layer construction and re-provided on every `extract` call.**
Only needed because the module-level `Command.exitCode` carries a `CommandExecutor` requirement. Acquire the service the same way `fs` is acquired one line below:

```ts
const executor = yield* CommandExecutor.CommandExecutor;   // CommandExecutor.d.ts:64
const exitCode = yield* executor.exitCode(Command.make("unzip", "-o", zipPath, "-d", targetDir)); // R = never
```
Then both the `Effect.context` capture and the trailing `Effect.provide(context)` go away. (The interface pins `R` to `never`, so the "callers can't swap the executor" worry does not apply — that is by design.)

**`src/sync/node.ts:114-120` — [LOW] `FileStore`/`ZipExtractor` subclasses fake `Effect.Service`'s generated `.Default` and duplicate an exported name.**
`Default`/`DefaultWithoutDependencies` are the names `Effect.Service` generates (`Effect.d.ts:26576`) and reserves (`Service.ProhibitedType`). The subclass buys nothing over the module-level layer const and creates a second exported `FileStore` distinct from the one at `src/index.ts:210`. Runtime is unaffected (Context resolves by `tag.key`).

```ts
// after — verified: tsc clean, 121/121
// sync/node.ts: keep only FileStoreNodeLive / ZipExtractorNodeLive
// cli.ts, scripts/compile-tasks.ts, test/cli.test.ts:
import { FileStore } from "./sync/contract.js";
import { FileStoreNodeLive } from "./sync/node.js";
const CliLive = Layer.mergeAll(TaskerCompiler.Default, FileStoreNodeLive, NodeContext.layer);
```

**`src/cli.ts:413` — [LOW] one composition root copied verbatim into three files.**
The same `Layer.mergeAll(TaskerCompiler.Default, FileStore.Default, NodeContext.layer)` is at `scripts/compile-tasks.ts:84` and `test/cli.test.ts:22-26`. Export `CliLive` from `src/cli.ts` and import it in the other two. Pure DRY — no Layer memoization is defeated (each is a separate program with its own runtime).

**`src/config.ts:229` — [LOW] `taskerConfigLayer` hides its `Tasker` requirement behind a self-provide.**
`Layer.unwrapEffect` already propagates R (`Layer.d.ts:1188`), so the honest type is `Layer<never, never, Tasker>`. Do this only together with the `sync/tasker.ts` change so the two agree; note `taskerConfigLayer` is public and the closed `Layer<never>` currently lets callers use it outside `runInTasker`.

**`src/config.ts:71` — [LOW] `makeTaskerConfigProvider` takes `Tasker` as an argument rather than from context.**
Defensible `make`-style constructor — the service boundary is `taskerConfigLayer`, which does resolve from context, and 11 tests drive the provider directly with `makeTestTasker`. If you want the R-channel form, *add* a wrapper rather than deleting the explicit one:

```ts
export const taskerConfigProvider = (options?: TaskerConfigOptions) =>
  Effect.flatMap(Tasker, (tasker) => makeTaskerConfigProvider(tasker, options));
```
Keep `TaskerConfigApi = Pick<TaskerShape, "global" | "performTask">` — a useful narrowing over a ~110-member interface, and widening it is a compile error, not silent drift.

---

## 4. Hand-rolled Effect primitives (`src/config.ts`)

**`src/config.ts:126-137` — [MED] the prompt poll is a counted `for` loop where `Schedule` + `timeoutFail` is the construct.**
The deadline is encoded as an *attempt count* (`Math.ceil(timeout / pollInterval)`), so wall-clock drifts by the cost of each `readGlobal` — the error message's "within ${timeout}ms" becomes a lie exactly in the slow case.

```ts
// after — hoist ONE ConfigError so the error channel stays ConfigError and retry on identity
const unanswered = ConfigError.MissingData([...path], `Tasker global %${name} … within ${timeout}ms`);
return yield* readGlobal(path, name).pipe(
  Effect.flatMap((v) => (v === undefined ? Effect.fail(unanswered) : Effect.succeed(v))),
  Effect.retry({ schedule: Schedule.spaced(Duration.millis(pollInterval)), while: (e) => e === unanswered }),
  Effect.timeoutFail({ duration: Duration.millis(timeout), onTimeout: () => unanswered })
);
```
`Schedule.spaced` (`Schedule.d.ts:2680`), `Effect.retry` options object (`Effect.d.ts:7449`), `Effect.timeoutFail` (`:12950`). An equivalent single-combinator form is `Effect.repeat(Effect.delay(readGlobal(...), pollInterval), { until: (v): v is string => v !== undefined })` + `timeoutFail` — do **not** pass `{ schedule: Schedule.spaced(...) }` there, `Repeat.Return` would give you the recursion count instead of the answer. Two accepted deltas: the first read now happens immediately after `performTask`, and a timeout smaller than `pollInterval` yields zero reads (today `Math.max(1, …)` guarantees one). `Effect.uninterruptibleMask`/`Exit.isInterrupted` at `:150+` is unaffected — `timeoutFail` surfaces a typed failure, not an interrupt.

**`src/config.ts:81, 106-114, 146-150` — [MED] `Ref<Map>` with hand-written copy-on-write and an `undefined` sentinel.**
Two `new Map(map)` copies exist purely to fake the immutability `Ref.modify`/`Ref.update` assume — one forgotten copy corrupts a concurrent reader's snapshot. `HashMap` is already imported's sibling (`HashSet` is used in this file).

```ts
// after — verified end to end: typecheck clean, 121/121, then reverted
const inFlight = yield* Ref.make(HashMap.empty<string, Deferred.Deferred<string, ConfigError.ConfigError>>());

const existing = yield* Ref.modify(inFlight, (map) =>
  Option.match(HashMap.get(map, name), {
    onSome: (found) => [Option.some(found), map] as const,
    onNone: () => [Option.none<typeof deferred>(), HashMap.set(map, name, deferred)] as const,
  })
);
if (Option.isSome(existing)) return yield* Deferred.await(existing.value);

const cleanup = Ref.update(inFlight, HashMap.remove(name));
// also: labels via HashMap.fromIterable; :123 → HashMap.get(labels, name).pipe(Option.getOrElse(() => name))
```

**`src/config.ts:81 + 100-172` — [MED] the whole single-flight/dedup cache duplicates `RcMap`.**
~70 lines of `Ref` + per-key `Deferred` + copy-on-write + manual eviction + interrupt bookkeeping. Under `RcMap` the lookup is forked into the entry's own scope, so no caller *owns* the prompt and the entire `Exit.isInterrupted` translation becomes unnecessary.

```ts
const prompts = yield* RcMap.make({ lookup: (key: ReadonlyArray<string>) => promptOnce(key, globalNameOf(key)) });
// in load(): yield* Effect.scoped(RcMap.get(prompts, Data.array([...path])))
```
Verified against `internal/rcMap.js`: concurrent gets share one forked lookup, and with `idleTimeToLive` omitted the entry is evicted the moment refCount hits zero — so a failed prompt is not cached. **Three mandatory consequences, decide deliberately:** (1) `makeTaskerConfigProvider` gains `Scope` in R, a public API break (`src/index.ts:188`), and `taskerConfigLayer` switches `Layer.unwrapEffect` → `Layer.unwrapScoped`; (2) `test/config.test.ts:189-247` must be rewritten — interrupting one reader no longer fails the others, it succeeds; (3) keying moves from global name to config path (`Data.array` for structural equality). Do **not** substitute `Effect.cachedFunction` or `Cache.make` — both retain the `Exit`, so one unanswered prompt would replay forever.

**`src/config.ts:151-171` — [LOW] `uninterruptibleMask` + `exit` + tap + re-raise is verbatim `Effect.onExit`.**
`onExit` is literally `uninterruptibleMask(restore => matchCauseEffect(restore(self), …))` (`internal/core.js:533`).

```ts
return yield* attempt.pipe(
  Effect.onExit((exit) =>
    Deferred.done(deferred, Exit.isInterrupted(exit) ? Exit.fail(/* … */) : exit).pipe(Effect.zipRight(cleanup))
  )
);
```
Keep the explanatory comment at `:140-145`. `Effect.ensuring` is not an alternative — its finalizer takes no `Exit`.

**`src/config.ts:85-97` — [LOW] `readGlobal` returns `string | undefined` where `Option<string>` is the type.**
Two call sites (`:130`, `:182`) hand-check the sentinel. `Option.fromNullable(value).pipe(Option.filter((t) => t !== ""))` — no cast needed, `fromNullable` does the runtime check regardless of the lying `string` binding type. Note the `const text: string | undefined = value` annotation at `:94` is *not* dead code: it is what makes the `=== undefined` comparison typecheck.

**`src/config.ts:45, :47` — [LOW] `promptTimeoutMillis`/`pollIntervalMillis` are raw numbers where `Duration.DurationInput` is the type.**
`DurationInput` already accepts a bare `number` as millis, so widening the two public fields is source-compatible (including `test/config.test.ts:34`), and callers gain `"2 minutes"`. `Duration.toMillis` accepts a `DurationInput` directly, so the arithmetic at `:126` needs no ceremony. Renaming the fields to drop the `Millis` suffix is breaking — prefer the non-breaking widening.

---

## 5. Structural error types & lost causes

**`src/sync/core.ts:84-101` — [MED] `downloadErrors` re-declares `HttpClientError` as loose inline shapes, losing the literal `reason` union.**
Annotating `reason: string` means `error.reason === "StatusCodes"` compiles and silently takes the wrong branch forever; `request`, `cause`, `description` are all dropped. Both handlers map the whole channel uniformly anyway.

```ts
const toDownloadError = (url: string) => (error: HttpClientError.HttpClientError) =>
  new DownloadError({
    message: error._tag === "ResponseError" && error.reason === "StatusCode"
      ? `Download returned ${error.response.status}` : error.message,
    url,
  });
// getText/getBytes: … .pipe(Effect.mapError(toDownloadError(url)))
```
Same shape at `src/sync/node.ts:44,:46`, where `{ readonly message: string }` stands in for `PlatformError` (`import { Error as PlatformError } from "@effect/platform"`). Note the inline handlers in `getJson` (`:69-71`) get the real inferred types — the fix is simply to stop hoisting handlers into an annotated factory.

**`src/tasker-api.ts:620-624` — [MED] `liveFn` flattens every Tasker builtin throw to `String(cause)`.**
This is the single chokepoint for all ~110 builtins; the stack, nested cause and non-`Error` payloads (`"[object Object]"`) are destroyed before `runtime.ts:50` renders the failure into the user's only on-device diagnostic.

```ts
// tasker-api.ts:167 — add a defect-typed field (same shape @effect/platform uses on BadArgument/SystemError)
cause: Schema.optional(Schema.Defect),
// :620
catch: (cause) => new TaskerCallError({ function: name, message: cause instanceof Error ? cause.message : String(cause), cause }),
```
**Both edits are required** — `src/runtime.ts:50` calls `Cause.pretty(cause)` with no options, so the new field is invisible until it becomes `Cause.pretty(cause, { renderErrorCause: true })` (`Cause.d.ts:1888`). Enable that in `runtime.ts` only; toasts are length-limited.

**`src/sync/tasker.ts:44, :72` and `src/sync/node.ts:44, :92` — [LOW] four `catchTags` sites with byte-identical branches.**
`Effect.mapError` covers the whole channel in one line.

```ts
writeText: (path, content) =>
  tasker.writeFile(path, content, false).pipe(
    Effect.asVoid,
    Effect.mapError((error) => new StorageWriteError({ message: error.message, path }))
  ),
```
In `node.ts` do not annotate the callback — inference already gives `PlatformError`, so no new import is needed.

**`scripts/compile-tasks.ts:56, :60-62` — [MED] bare `new Error(...)` in an otherwise fully tagged pipeline, with `String(cause)` discarding the Bun diagnostic.**
`main`'s channel becomes `CompileError | StorageWriteError | RepoDetectionError | Error`; the untagged member can never be caught by tag, and the thrown value's stack is gone before `console.error` at `:88` sees it.

```ts
class BundlerCrashed extends Data.TaggedError("BundlerCrashed")<{ readonly cause: unknown }> {}
class BundleFailed  extends Data.TaggedError("BundleFailed")<{ readonly logs: ReadonlyArray<string> }> {}
```
`Data.TaggedError` (`Data.d.ts:610`) is the right pick for a build script — CLAUDE.md's `Schema.TaggedError` rule targets library errors.

**`src/cli.ts:110-117` — [LOW] `RepoDetectionError` drops the `PlatformError` cause.**
Smaller loss than it looks: `SystemError.message` already embeds reason/module/method/path, and "not a git repository" is handled separately by the exit-code path at `:118-124`. Only spawn-level failures reach this branch.

```ts
// :63  add  cause: Schema.optional(Schema.Defect)
message: cause._tag === "SystemError" && cause.reason === "NotFound"
  ? "`git` was not found on PATH — pass --repo <owner>/<name> instead."
  : `Could not run \`git remote get-url origin\`: ${cause.message}`,
cause,
```

**`src/runtime.ts:26-32, :52-62` — [LOW] bare `catch {}` around `raw.flash`/`raw.exit`.**
Subsumed by the `runtime.ts` layer-ordering fix in §3. The residue after that fix is that on-device failures (bad argument, WebView bridge error) are still indistinguishable from "not on a device" unless you use `Effect.ignoreLogged` rather than `Effect.ignore`.

---

## 6. Imperative loops & `Match` exhaustiveness

**`src/sync/core.ts:137-147` — [MED] per-asset download/write loop with a mutable accumulator.**
Each asset is an independent download + write, but the loop hard-codes concurrency 1 by construction.

```ts
const written = yield* Effect.forEach(assets, (asset) =>
  Effect.gen(function* () {
    const content = yield* getText(asset.browser_download_url, options.token);
    const path = `${targetDir}/${asset.name}`;
    yield* files.writeText(path, content);
    yield* Effect.log("Synced release asset", { asset: asset.name, path });
    return asset.name;
  }), { concurrency: 1 });
```
Keep `{ concurrency: 1 }` as the drop-in — byte-identical behaviour with the mutable array gone and the policy stated. Raising it is a **separate** decision: concurrency makes the partial-write set non-deterministic instead of a clean prefix (a stale `dispatcher.js` next to a fresh `sync-profiles.js`). Pair any bump with write-to-temp-then-rename or download-all-then-write-all.

**`src/compiler.ts:116-131` — [MED] `emitJsCode`'s unguarded tail leaves the `Text` union open, and it is the third copy of the same part-dispatch.**
`return [\`${emitText(code)};\`]` accepts anything left over, because `emitText` takes the whole union — a fifth `Text` member would compile clean and emit a bare `<expr>;` statement into the generated JS.

```ts
// verified: passes bun run typecheck; Match.tag accepts several tags per arm (Match.d.ts:620)
const emitPart = Match.type<TextPart>().pipe(
  Match.when(Match.string, (s) => s),
  Match.tag("Secret", (s) => `global(${js(s.name)})`),
  Match.tag("VariableRef", (v) => readVarExpr(v.name)),
  Match.exhaustive
);
const emitJsCode: (code: Text) => Array<string> = Match.type<Text>().pipe(
  Match.when(Match.string, (s) => s.split("\n")),
  Match.tag("Interpolated", (i) => i.parts.map(emitPart).join("").split("\n")),
  Match.tag("Secret", "VariableRef", (ref) => [`${emitText(ref)};`]),
  Match.exhaustive
);
```

**`src/compiler.ts:96-108` — [MED] `emitText` dispatches a tagged union with `typeof`/`instanceof`.**
The final branch is an unchecked assumption that whatever is left is `Interpolated`; the only thing that would flag a new member is the incidental `.parts` access. `instanceof` is also realm-dependent, and `emitText` is a public export (`src/index.ts:153`) — I reproduced `emitText(JSON.parse(JSON.stringify(secret("KEY","a key"))))` throwing `TypeError: undefined is not an object`. (Inside the CLI this cannot happen: `src/cli.ts:150-176` re-instantiates through the schemas.)

```ts
export const emitText: (value: Text) => string = Match.type<Text>().pipe(
  Match.when(Match.string, (s) => js(s)),
  Match.tag("Secret", (s) => `global(${js(s.name)})`),
  Match.tag("VariableRef", (r) => readVarExpr(r.name)),
  Match.tag("Interpolated", (i) => i.parts.map(emitPart).join(" + ")),
  Match.exhaustive
);
```

**`src/compiler.ts:986-997` — [LOW] `collectTaskRefs` uses an `_tag` if/else chain and a mutable accumulator where the rest of the file uses `Match`.**

```ts
const refsOf: (action: Action) => Array<string> = Match.type<Action>().pipe(
  Match.tag("PerformTask", (a) => [a.taskName]),
  Match.tag("If", (a) => [...collectTaskRefs(a.then), ...collectTaskRefs(a.orElse)]),
  Match.orElse((): Array<string> => [])
);
const collectTaskRefs = (actions: ReadonlyArray<Action>): Array<string> => actions.flatMap(refsOf);
```
Do **not** `import { Array } from "effect"` in this file — it shadows the global `Array<T>` used in these very signatures. Use native `.flatMap` or alias the import. No safety gain: TS already rejects a comparison against a tag outside the union (TS2367), and `Match.tag` is no better at catching a `PerformTask`/`PerformTaskerTask` swap.

**`src/compiler.ts:169, :242` — [LOW] `emitAction`'s 35-arm `Match` chain is split across two `.pipe()` calls to dodge pipe's 20-argument arity limit.**
Load-bearing and undocumented; whoever adds arm 36 gets an opaque overload error.

```ts
const matchAction: (a: Action) => Array<string> = Match.type<Action>().pipe(
  Match.withReturnType<Array<string>>(),
  Match.tagsExhaustive({ Flash: (a) => [...], /* one entry per tag, order irrelevant */ If: (a) => {...} })
);
```
Verified with all 35 tags: `bun run typecheck` passes, and removing the `If` key errors `TS2345: Property 'If' is missing`. Exhaustiveness already holds today — this is fragility, not a hole.

**`src/profile.ts:172-179` — [LOW] `fmt`'s `instanceof` chain has a stringifying tail.**
Unreachable for today's `FmtValue`, but adding a fourth reference kind would silently interpolate a `Secret(...)` dump into compiled JS.

```ts
const pushValue = (push: (part: TextPart) => void) => Match.type<FmtValue>().pipe(
  Match.tag("Secret", "VariableRef", (ref) => push(ref)),
  Match.tag("Interpolated", (i) => i.parts.forEach(push)),
  Match.when(Match.string, (s) => push(s)),
  Match.when(Match.number, (n) => push(String(n))),
  Match.when(Match.boolean, (b) => push(String(b))),
  Match.exhaustive
);
```
The matcher must be built inside `fmt` (or take `push`), since `push` closes over the per-call `parts` array. Spelling the three primitives out — rather than `Match.orElse` — is what makes exhaustiveness load-bearing.

**`src/cli.ts:200-211` — [LOW] `resolveEntry` hand-writes an effectful `findFirst`.**

```ts
const found = yield* Effect.findFirst(candidates, (c) => fs.exists(c).pipe(Effect.orElseSucceed(() => false)));
return yield* Option.match(found, {
  onNone: () => Effect.fail(new EntryNotFoundError({ message: `…Tried: ${candidates.join(", ")}`, tried: candidates })),
  onSome: (c) => Effect.succeed(path.resolve(c)),
});
```
`Effect.findFirst` (`Effect.d.ts:2353`) runs predicates sequentially and short-circuits, so `fs.exists` stays lazy.

**`src/compiler.ts:962` — [LOW] `localeCompare` makes `secrets.json`'s byte order locale-dependent.**
Measured for this repo's naming convention: `["A_B","AAB","API_2","API1"]` under `localeCompare` vs `["AAB","API1","API_2","A_B"]` under codepoint order — `_`-joined uppercase names are exactly the Tasker global convention.

```ts
const byNameOrder = Order.mapInput(Order.string, (secret: Secret) => secret.name);
return Arr.sortBy(byNameOrder)([...byName.values()]);   // sortBy is data-last only in 3.22.1
```
One-time reordering of any committed `secrets.json` with `_` names. **Do not** apply the same swap to `src/compiler.ts:1007`'s neighbours blindly, and note `Order.string` ≠ `localeCompare` for human-readable strings.

**`src/compiler.ts:1007, :1012` — [LOW] linear `Array.includes` for membership in the linker.**
`const targets = new Set(project.tasks.map((t) => t.name))` + `targets.has(ref)` states the intent. A plain `Set` is right here — nothing needs `HashSet`'s persistence or structural equality, and the function is not in Effect land.

**`src/sync/core.ts:168-181` — [LOW] `candidates[0]` + hand-written `undefined` check is `Option` longhand.**

```ts
return yield* Arr.head(
  Arr.sortWith(response.artifacts.filter((a) => !a.expired), (a) => a.created_at, Order.reverse(Order.string))
).pipe(Effect.mapError(() => new NothingToSyncError({ message: `No CI artifact named "${name}" found` })));
```
Ignore the complexity argument — `per_page=10` caps the array at ten. `Order.string` is codepoint order, safe here only because `created_at` is ISO-8601.

---

## 7. Option vs undefined (`src/cli.ts`)

**`src/cli.ts:150` — [MED] `decodeOrUndefined` re-implements `Schema.decodeUnknownOption`, and discards the `ParseError`.**
The one-line dedupe is non-breaking:

```ts
const decodeOrUndefined = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));   // Schema.d.ts:256
```
`Either` then becomes unused in the file. The discarded `ParseError` is *deliberate* on the structural-probe path (a parse failure means "not this kind"), but it also means a structurally-close-but-invalid export is silently skipped and the user sees only `"<entry> has no compilable exports"` (`:264`). If you want that diagnostic, collect the rejections and fold them into `NoCompilableExportsError.message`. Changing `asCompilable`'s `| undefined` return type is a separate, breaking decision (`test/cli.test.ts:75-77` asserts `toBeUndefined()`).

**`src/cli.ts:182-185` — [LOW] `[] : [x]` in a `flatMap` is a hand-written `Array.filterMap`.**

```ts
Arr.filterMap(Object.entries(module), ([exportName, raw]) =>
  Option.map(Option.fromNullable(asCompilable(raw)), (value) => ({ exportName, value }))
);
```

**`src/cli.ts:372-377` + `:277-283` — [MED] `Option`s from @effect/cli are flattened to `undefined` at the boundary, and the repo cache is a mutated captured `let`.**
`Args.optional`/`Options.optional` already produce `Option`; `getOrUndefined`-ing them forces nullable signatures on `runCompile`/`compileEntry`/`resolveEntry` and hand-written `!== undefined` tests at `:199` and `:279`.

```ts
// :372  ({ entry, out, repo }) => runCompile({ entry, outDir: out, repo })
// :194  const candidates = Option.match(entry, { onNone: (): ReadonlyArray<string> => DEFAULT_ENTRIES, onSome: Arr.of });
// :277  — keep single-detection explicitly; a bare Option.match re-runs `git remote get-url origin` per Project export
const resolveRepo = yield* Effect.cached(
  Option.match(options.repo, { onNone: () => detectRepoFromGit(), onSome: Effect.succeed })
);
```
`Effect.cached` (`Effect.d.ts:725`) also replaces the current `let repo` mutation — a memo that lives outside the runtime, is not atomic, and is invisible to the type system. `test/cli.test.ts:103/136/145` must move to `Option.some(...)`/`Option.none()`.

**`src/cli.ts:80-87` — [LOW] `parseGitHubRepo` returns `RepoRef | undefined`.**
`Option.fromNullable(RE.exec(url.trim())).pipe(Option.flatMap(...), Option.map(...))` compiles as written, but it is a public export with tests asserting `toBeUndefined()`. Do **not** claim `Arr.get` hardens the `match[1]!` assertions — it returns `Option.some(undefined)` for an in-bounds unmatched group; only `Option.fromNullable(match[1])` closes that. Leave `src/cli.ts:357` alone (inside `Options.mapTryCatch`, whose contract is a throwing callback).

**`src/cli.ts:350-360` — [LOW] `throw new Error` as control flow inside `Options.mapTryCatch`, discarding the rejected value.**
`onError` is `() => HelpDoc.p(...)` — it ignores its argument, so the only place the bad value appears is built and thrown away.

```ts
Options.mapEffect((value) => {                       // Options.d.ts:379
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  return match === null
    ? Effect.fail(ValidationError.invalidValue(HelpDoc.p(`--repo requires <owner>/<name>, got "${value}"`)))
    : Effect.succeed<RepoRef>({ owner: match[1]!, repo: match[2]! });
})
```
Identical failure value — `mapTryCatch` is implemented as exactly this (`internal/options.js:200`) — plus the rejected input in the message.

**`src/tasker-api.ts:603-606` — [LOW] `lookupRaw` returns `AnyRawFn | undefined`.**
`Option.fromNullable(...).pipe(Option.filter((c): c is AnyRawFn => typeof c === "function"))` compiles, but do not claim it removes a cast: the type predicate carries exactly the same unchecked assumption as `as AnyRawFn`. Leave the `raw` Proxy path (`:727-739`) alone — it is the documented Effect-free escape hatch.

---

## 8. Program edges & runners

**`scripts/compile-tasks.ts:81-90` — [MED] hand-rolled runner instead of `NodeRuntime.runMain`.**
Loses rendered `Cause` reporting (a defect prints as a raw thrown value), SIGINT/SIGTERM → fiber interruption (Ctrl-C kills the process mid-write with no finalizers), and Exit-derived exit codes. The file already imports from `@effect/platform-node`.

```ts
import { NodeContext, NodeRuntime } from "@effect/platform-node";
NodeRuntime.runMain(main.pipe(Effect.provide(Layer.mergeAll(TaskerCompiler.Default, FileStore.Default, NodeContext.layer))));
```
`runMain` terminates the process itself — keep it as the last statement (it already is).

**`scripts/compile-tasks.ts:14-15, :33, :40-42` — [LOW] `readdirSync`/`join` from `node:*` inside `Effect.gen` while `FileSystem` and `Path` are already provided at `:84`.**
A throw becomes a `Cause.Die` defect rather than a typed `PlatformError`, and the same generator writes through `FileStore` one function above.

```ts
const fs = yield* FileSystem.FileSystem;
const path = yield* Path.Path;
const entrypoints = (yield* fs.readDirectory(SCRIPTS_DIR)).filter((n) => n.endsWith(".ts")).map((n) => path.join(SCRIPTS_DIR, n));
```
To drop `node:path` entirely, convert `compileDslProject`'s `join(OUTPUT_DIR, file.filename)` (`:33`) too. Add an `fs.exists` early-return **only** if you want a missing `tasks/scripts` to be a no-op — today it fails the build.

**`src/cli.ts:424-456` — [LOW] `runCli` reports defects as a raw promise rejection and wires no interruption.**
**Keep the `Promise<number>` contract** — it is documented at `:419-423` and `bin/tasker-effect.mjs` depends on it; do not switch to `runMain`. `QuitException` cannot escape here (`Command.run` is typed `Effect<void, E | ValidationError, …>`), so the existing `catchTags` block is exhaustive. Fix only the two real gaps:

```ts
const exit = await Effect.runPromiseExit(program, options?.signal && { signal: options.signal });
if (Exit.isSuccess(exit)) return exit.value;
if (Exit.isInterrupted(exit)) return 130;
console.error(Cause.pretty(exit.cause));
return 1;
```
…and wire `AbortController` to SIGINT/SIGTERM in `bin/tasker-effect.mjs`.

---

## 9. HTTP & sync (`src/sync/core.ts`)

**`src/sync/core.ts:65-82, :123, :165` — [MED] `getJson` returns `unknown` and defers decoding to the hand-rolled `decodeAs` (`:44-55`); `HttpClientResponse.schemaBodyJson` does both in one step.**

```ts
const getJson = <A, I>(schema: Schema.Schema<A, I>, url: string, token: string | undefined) =>
  client.get(url, { headers: apiHeaders(token) }).pipe(   // KEEP the headers — dropping them loses Authorization
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),   // HttpIncomingMessage.d.ts:43
    Effect.catchTags({
      RequestError: (e) => Effect.fail(new GitHubApiError({ message: e.message, url })),
      ResponseError: (e) => Effect.fail(/* StatusCode branch unchanged */),
      ParseError:    (e) => Effect.fail(new GitHubApiError({ message: `Unexpected GitHub API payload: ${e.message}`, url })),
    })
  );
```
Both call sites collapse to `yield* getJson(Release, url, options.token)`; `decodeAs` is deleted. `getText`/`getBytes` are untouched (not JSON). Failure surface is unchanged — `schemaBodyJson` goes through the same `response.json`.

**`src/sync/core.ts:37-42` — [LOW] constant GitHub headers rebuilt at three call sites.**
Decorate the client once with `HttpClient.mapRequest(HttpClientRequest.setHeaders({...}))` and derive the authenticated variant per call with `HttpClientRequest.bearerToken(token)` (must stay per-call — the token arrives via `SyncOptions`). Do **not** justify this as a secret-leak fix: redaction is name-based (`authorization` is already in `Headers.currentRedactedNames`), so today's plain record is redacted identically. The payoff is that `bearerToken` accepts `string | Redacted`, opening the door to `Config.redacted` later.

**`src/sync/core.ts:59-61` — [LOW] the shared client declares no transient-retry policy.**
Not a hand-rolled retry — a missing one. `HttpClient.retryTransient({ times: 3, schedule: Schedule.exponential("250 millis").pipe(Schedule.jittered) })` (`HttpClient.d.ts:478`) retries transport errors and 408/429/500/502/503/504 while leaving 404/auth/parse failures alone, with no change to the error channel. Weigh it against on-device wall time: this client also backs `SyncTaskerLive`. Do **not** pair it with `Effect.timeout` — that widens E with `TimeoutException`, contradicting the declared union at `src/sync/node.ts:129-133`; use `Effect.timeoutFail` with a `DownloadError` if you want a stall guard.

**`src/sync/core.ts:201-210` — [LOW] the downloaded artifact zip is left in `targetDir` and reported in `SyncResult.files`.**
`ZipExtractorNodeLive.extract` returns `fs.readDirectory(targetDir)` (`src/sync/node.ts:87`), so the zip is announced as a synced file. Fix the observable half now — `files: extracted.filter((name) => name !== zipName)` — with no contract change. The leftover file itself needs `remove` on `FileStoreShape` before `Effect.acquireRelease` is even available, and the Tasker implementation would have to stub it as `Effect.void`. `pullFromArtifacts` is Node/CI-only by design, so the leak never reaches a device.

---

## 10. Tests

**`src/tasker-api.ts:685-698` — [MED] `makeTestTasker` records calls at Effect *construction* time while `liveFn` is `Effect.suspend`-lazy.**
An effect built but never yielded is recorded as a call that never happened; an effect executed N times is recorded once. Every `expect(calls.filter(...)).toHaveLength(n)` rests on that coincidence. No test is wrong today, but the next `Effect.retry`/`repeat`/never-taken-`orElse` around a hoisted Tasker effect breaks one silently.

```ts
(...args: ReadonlyArray<unknown>) =>
  Effect.suspend((): Effect.Effect<unknown, TaskerApiError> => {
    calls.push({ name, args });
    const override = overrides[name];
    return override !== undefined ? override(...args) : Effect.succeed(testDefault(name));
  })
```
`calls` stays a plain array read synchronously after `runPromise` — verified safe against `test/tasker-api.test.ts:37` and `test/config.test.ts:53/71/149/243`. Do **not** swap it for `Ref`.

**`test/config.test.ts:34, :204-245` — [MED] the poll loop is tested with wall-clock sleeps and non-production timings.**
`FAST = { pollIntervalMillis: 5, promptTimeoutMillis: 100 }` means the shipped 1s/120s arithmetic never runs, and the interruption test synchronises two forked fibers with literal 30ms/10ms sleeps. `TestClock` ships in `effect` itself (no `@effect/vitest` needed) and `TestClockImpl.run` awaits all descendant fibers suspended before advancing — a stronger guarantee than "yields once".

```ts
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e.pipe(Effect.provide(TestContext.TestContext)));
const PROD = { pollIntervalMillis: 1_000, promptTimeoutMillis: 120_000 };

const owner = yield* Effect.fork(readKey);
yield* TestClock.adjust("1 second");
const waiter = yield* Effect.fork(readKey.pipe(Effect.flip));
yield* TestClock.adjust("1 second");
yield* Fiber.interrupt(owner);
const waiterError = yield* Fiber.join(waiter);
```
Verified end to end (1 pass, ~0.4s wall clock, production timings). **Drop the two `Effect.timeoutFail({ duration: "1 second" })` guards at `:223-226` and `:233-236`** — under the test clock they can never fire, so a real hang becomes a deadlock. The final "later read" must be forked and driven with an `adjust`. Keep the `toContain("interrupted")` message assertion alongside `ConfigError.isMissingDataOnly` — both paths produce `MissingData`.

**`test/compiler.test.ts:452-463` — [LOW] `let error: unknown` + try/catch + `as CompileError`.**
Keep testing the pure function directly — the next test (`:466`) already covers the service path, and this is the only direct coverage of `compileProjectFiles`. bun's `toThrow(string)` does substring matching, so this collapses to the form already used at `:335`:

```ts
const compile = () => compileProjectFiles(project, { repo: TEST_REPO });
expect(compile).toThrow(CompileError);
expect(compile).toThrow('unknown task "Weather Check"');
```
If you want structured assertions, use `expect.unreachable(...)` in the try so the no-throw case fails loudly, and assert `error._tag` / `error.source` rather than casting.

**`src/tasker-api.ts:705-716` — [LOW] `TaskerTest` and `makeTaskerTestLayer` duplicate construction and differ (`Layer.sync` vs `Layer.succeed`) for no stated reason.**
`Tasker.make(api)` is exactly `new this(service)` (`Effect.js:10350`) — it avoids no prototype patching and fixes no typing problem, so this is consistency only. If you unify, **keep `Layer.sync`**: defining `TaskerTest = makeTaskerTestLayer().layer` would build one module-load-time recorder whose `calls` array grows for the whole test process.

---

## 11. Consumer-facing code

**`examples/basic.ts:46` — [LOW] `Effect.sync(() => process.stdout.write(...))` where `Console.log` is the construct.**
The only file outside the sanctioned Node edges touching the `process` global, in the library's teaching surface.

```ts
yield* Console.log(compileTaskToJs(eveningWindDown));   // Console.d.ts:160 — appends the newline
```

**`examples/basic.ts:49-51, :54-56` — [LOW] `for`-of over `Effect.log`.**
Semantically identical to `Effect.forEach(..., { discard: true })`; worth changing only because this is the example consumers copy. Everywhere else in the repo, leave sequential `for`-of loops alone (see below).

**`tasks/scripts/battery-report.ts:19-25` — [LOW] NaN sentinel + imperative early `return`.**
`parseInt("88%")` is `88` and `parseInt("12abc")` is `12`, so a malformed global produces a plausible-looking battery level instead of the "unknown" path.

```ts
const parseLevel = Schema.decodeUnknownOption(Schema.NumberFromString);
yield* Option.match(parseLevel(battery), { onNone: () => tasker.flash("Battery level unknown"), onSome: (level) => /* … */ });
```
Verified: `NumberFromString` returns `None` for `""`, `"88%"` and `"12abc"`, so the empty-global path is unchanged. Use `decodeUnknownOption`, not `Number.parse` — the latter takes `string` and the raw builtin can hand back `undefined`. Weigh the `effect/Schema` bundle cost for an on-device script.

**`tasks/scripts/sync-profiles.ts:23` — [LOW] `Effect.orElseSucceed(() => "")` erases `TaskerApiError`.**
"Tasker is not available" becomes indistinguishable from "the user never set the override", and the sync silently targets the hard-coded default repo.

```ts
const globalOr = (name: string, fallback: string) =>
  Effect.map(Effect.flatMap(Tasker, (t) => t.global(name)),
    (value: string | undefined) => (value === undefined || value === "" ? fallback : value));
```
Keep reading the globals directly — see "Deliberate and fine" on why `Config.withDefault` is wrong here.

**`src/profile.ts:869, :828, :802, :874, :985, :1018` — [LOW] DSL builders mix ms / seconds / minutes with only parameter names to distinguish them.**
`Action.wait(30)` and `{ timeoutSecs: 30 }` differ by 1000× with no type-level signal. Widen the *builder parameters* to `Duration.DurationInput` (schema fields stay numeric, so codegen is untouched); existing numeric callers keep compiling. Two caveats: guard the conversion (`Duration.toSeconds(Duration.millis(500))` is `0.5`, `toMillis(Duration.infinity)` is `Infinity`, and the schema filters are only `positive()`/`nonNegative()`), and renaming `timeoutSecs` → `timeout` is a breaking change to a published authoring surface.

---

## Deliberate and fine — do not "fix" these

- **Emitted-JS string literals and the import-once `tasker-effect.prj.xml`.** Plain ES5 by design; Effect primitives never belong there. The compiler code that *produces* them is in scope, the strings are not.
- **`compileTaskToJs` / `compileProjectFiles` / `collectProjectSecrets` are pure, synchronous functions.** CLAUDE.md pins the codegen path this way, and `tryCompile` is the sanctioned single Effect boundary. Use `Either` for their failures; never convert them to `Effect` (it would cascade through every pure caller and test).
- **Sequential `for (const x of xs) { yield* eff }` inside `Effect.gen`.** Identical to `Effect.forEach` at default concurrency — ordered, short-circuiting, interruptible. Applies to `src/cli.ts:287,295`, `scripts/compile-tasks.ts:32,65`, `src/config.ts`. Only `src/sync/core.ts:137` is a finding, and only because of the mutable accumulator.
- **`candidates[0]` followed by `=== undefined` (`src/sync/core.ts:172`).** `tsconfig` sets `noUncheckedIndexedAccess`, so the guard is compiler-enforced, not dead code.
- **`walkSecrets`' `seen: Set<object>` (`src/compiler.ts:903-920`).** Must stay an identity `Set` — the nodes are `Schema.TaggedClass` instances with structural `Equal`, so `HashSet` would prune distinct-but-equal branches.
- **The `instanceof` ternary in `compileEntry` (`src/cli.ts:287-292`).** `asCompilable` re-instantiates through the schemas, so `instanceof` cannot fail there, and TS narrowing already makes the tail exhaustive — a fourth kind in `CompilableExport.value` is a build break today.
- **The per-tag `catchTags` block in `runCli` (`src/cli.ts:428-451`).** Driven by the actual inferred error channel; replacing it with a hand-written union + `Match.exhaustive` would turn a type-level leftover into a runtime throw inside the error handler.
- **`runCli`'s `Promise<number>` signature.** Documented contract consumed by `bin/tasker-effect.mjs`. `NodeRuntime.runMain` belongs in `scripts/compile-tasks.ts`, not here.
- **`Config` + `taskerConfigLayer` as the only way to read *secrets* from Effect land — but not for optional unattended overrides.** `promptFor` prompts for any unset key, so `Config.string("SYNC_OWNER").pipe(Config.withDefault(...))` would pop a `TE Config` dialog on every 6-hourly sync and stall for `promptTimeoutMillis`. Do **not** gate `promptFor` on declared secrets to enable it — that contradicts `src/config.ts:15-16` and fails `test/config.test.ts:78-89`.
- **`value === undefined` checks against `tasker.global`'s `string` return.** Load-bearing: Tasker really returns `undefined` for unset globals despite the binding type (`src/config.ts:92-93`). Both `src/config.ts:94` and `tasks/scripts/sync-profiles.ts:24` are correct.
- **`TaskerConfigApi = Pick<TaskerShape, "global" | "performTask">`.** A useful narrowing over a ~110-member interface; widening it is a compile error, not silent drift.
- **`raw` (`src/tasker-api.ts:727-739`).** Documented non-Effect escape hatch; keep it Option-free and Effect-free.
- **`localeCompare` vs `Order.string` is not a free swap.** Safe for ISO-8601 timestamps; for user-authored secret names (`src/compiler.ts:962`) it is a real ordering change — worth making, but deliberately.
- **`Array.get` does not harden `match[1]!`.** It returns `Option.some(undefined)` for an in-bounds unmatched group; only `Option.fromNullable(match[1])` closes that hole.
- **Effect 4 is not used and must not be suggested.** Nothing above requires it.