# Implementation plan: inline secrets + Tasker ConfigProvider

Status: approved 2026-08-20. Supersedes the `Task.secrets` / `Project.secrets`
design shipped in `6b301d1`. The on-device flow (secrets.json → sync →
`TE Config` prompting) and the project XML architecture stay; what changes is
how secrets are *declared/detected* in the DSL and how *Effect scripts* read
them.

## Verified constraint driving the design

Tasker performs **no** `%variable` replacement anywhere in the JS path — not
in JavaScriptlet Code fields, not in JS file content, not in strings passed to
builtins (userguide's own example is `flash( global( '%DogName' ) )`).
Therefore:

- "Use a secret/variable inside a string" must compile to
  `"prefix " + global("NAME") + " suffix"`, never to a `"%NAME"` literal.
- The existing `Action.flash("Current temperature: %TEMPERATURE °C")` in
  `tasks/automations.ts` is silently broken on-device today (flashes literal
  text). This plan fixes it via interpolation.

## Decisions (settled — do not re-litigate)

1. **Detection = action-tree walk.** The compiler walks the compiled
   `Project`'s actions and collects every `Secret` object it encounters at a
   use site. Only *referenced* secrets are emitted to `secrets.json`. No
   global registry. Dedupe by name; two secrets with the same name but
   different descriptions → `CompileError`.
2. **Delete `Task.secrets` and `Project.secrets`** (and the field-based
   aggregation in `collectProjectSecrets`). Declaration form stays
   `const API_KEY = secret("OPENWEATHER_KEY", "OpenWeather API key")`.
3. **Effect scripts read secrets via `Config` only**, backed by a Tasker
   `ConfigProvider` (see below). No compile-time escape hatch.
4. **Inline positions:** every string *content* field accepts interpolation
   (`fmt` template / bare `Secret` / bare `VariableRef`), and variable-*name*
   positions (`cond(...)` variable, `outputGlobal` fields, `SetGlobal.name`)
   accept a bare `Secret`.
5. **`Action.js` participates:** `Action.js(fmt`...`)` splices refs as
   `global("NAME")` *expressions* into the code. Hand-written
   `global("NAME")` strings remain undetected by design (documented).
6. **Runtime XML flow stays**, except `TE Config` gains a parameterized
   one-off mode (still exactly 3 tasks + 1 profile in the XML).
7. **Syntax:** tagged template `` fmt`Bearer ${API_KEY}` `` producing a
   schema-valid interpolation value; bare `Secret` accepted as a whole field
   value.
8. **Variables too:** `` fmt`Temp: ${v("TEMPERATURE")} °C` `` — `v()` makes a
   `VariableRef`; ALL-CAPS → `global(...)`, lowercase → `local(...)` (reuse
   `isGlobalVariable`). Migrate the broken `%VAR`-in-string usages in
   `tasks/automations.ts` (and `examples/` if any).
9. **Prompting from a running script:** `TE Config` called with `%par1`
   (global name) / `%par2` (prompt label) prompts for exactly that key and
   `setGlobal`s the answer; with no `%par1` it does today's secrets.json
   scan.
10. **Provider API:** `taskerConfigLayer(options?)` with
    `{ secrets?: ReadonlyArray<Secret>, promptTimeoutMillis?, pollIntervalMillis? }`.
    Programs use idiomatic `Config.string("OPENWEATHER_KEY")`. Config path
    segments are joined with `_` and uppercased to form the Tasker global
    name. Prompt label = matching declared `Secret`'s description, else the
    bare name.
11. **Prompt for any missing key**, not just declared secrets.
12. **Failure/waiting semantics:** on a missing global the provider performs
    `TE Config` (par1=name, par2=label), then polls the global (default every
    1s, bounded default 120s). Unanswered/dismissed → idiomatic
    `ConfigError.MissingData` whose message names the Tasker global.
    Concurrent reads of the same missing key are deduped into one prompt.
13. **Delete `requireSecret` and `MissingSecretError`** (and the `SecretRef`
    interface) — the ConfigProvider is the only way to read a secret from
    Effect land.

## Implementation

### A. `src/profile.ts` — interpolation model

- Keep `Secret` (Schema.Class, name pattern `^[A-Z][A-Z0-9_]*$`, description)
  and `secret()`.
- Add `VariableRef` (Schema.TaggedClass, `{ name }`, `%` stripped) and
  builder `v(name)`.
- Add `Interpolated` (Schema.TaggedClass) holding
  `parts: Array<string | Secret | VariableRef>` — parts must stay
  JSON-serializable through the schema (Secret needs a `_tag`-discriminable
  encoding inside the union; if plain `Schema.Class` unions are awkward,
  give the parts union explicit member schemas — implementer's choice, but
  encode/decode must round-trip).
- `fmt` tagged template: accepts interpolation values of type
  `Secret | VariableRef | Interpolated | string | number | boolean`;
  flattens nested `Interpolated`; merges adjacent literals; returns
  `Interpolated` (or a plain string when there are no refs).
- Widen field schemas:
  - `TextValue = string | Interpolated | Secret | VariableRef` for content
    fields: Flash.text, Popup.title/text, Say.text, SetGlobal.value,
    SetLocal.value, Shell.command, ReadFile.path, WriteFile.path/text,
    HttpRequest.url/body + header values, BrowseUrl.url, SendSms.number/text,
    SetClip.text, SetWallpaper.path, MusicPlay.path, LaunchApp.app/data,
    SendIntent data/extras, PerformTaskerTask.parameterOne/Two,
    JavaScript.code.
  - `VarName = string | Secret` for: Condition.variable,
    SetGlobal.name, `outputGlobal` fields (Shell, ReadFile, HttpRequest).
  - Task/profile *names* and trigger fields stay plain strings.
- Update the `Action` builders to accept the widened types (keep plain-string
  calls source-compatible).

### B. `src/compiler.ts` — emission + detection

- `emitText(value): string` → a JS *expression*: string → `js(...)`;
  `Secret` → `global("NAME")`; `VariableRef` → `global(...)`/`local(...)` by
  convention; `Interpolated` → parts joined with ` + ` (literal parts as JSON
  strings). Empty interpolation → `""`.
- `emitJsCode(value): Array<string>` for `JavaScript.code`: plain string
  verbatim (as today); `Interpolated` → literal parts verbatim with refs
  spliced as `global("NAME")` / `local("name")` expression text.
- Replace `js(a.field)` call sites with `emitText` for all widened fields;
  Condition compile accepts `Secret` as variable (always global).
- **Secret collection**: `collectProjectSecrets(project)` becomes a walk over
  every profile enter/exit task and standalone task: visit every widened
  field, `If` then/orElse recursively, header records, extras arrays.
  Conflict rule unchanged. `compileSecretsJson` unchanged otherwise;
  `secrets.json` still always emitted.
- Migrate `tasks/automations.ts` (and any example) off `"%VAR"`-in-string:
  use `fmt` + `v()`.

### C. `TE Config` one-off mode (project XML in `src/compiler.ts`)

- `configScanJs`: if `local("par1")` is set → check `global(par1)`; when
  unset/empty, `setLocal("te_missing", par1)` and, if `local("par2")` set,
  `setLocal("te_label", par2)`; then `exit()` (skip the secrets.json wait
  loop entirely in this mode). Otherwise: existing scan behavior.
- Label-lookup scriptlet (act3): prefer `local("te_label")` when set, else
  the existing secrets.json lookup, else the name.
- Still exactly 3 tasks + 1 profile; XML stays static/generic (par1/par2 are
  runtime inputs, nothing user-specific is embedded).

### D. `src/config.ts` (new) — Tasker ConfigProvider

- Platform-free module (no node imports — the browser-bundle guard test must
  stay green); exported from `src/index.ts`.
- `makeTaskerConfigProvider(tasker, options)` (unit-testable with
  `makeTestTasker`) + `taskerConfigLayer(options?)` that builds the provider
  from `Tasker.Default` and applies `Layer.setConfigProvider`.
- Behavior per decisions 10–12. Use whatever `ConfigProvider` construction
  Effect 3.22 supports (`fromFlat`/custom); enumeration ops may be
  unsupported (empty) — document that `Config.record`/listing won't work.
- Global-name mapping: path segments joined `_`, uppercased.
- In-flight prompt dedup via a keyed map of deferreds (per provider
  instance).
- `performTask(CONFIG_TASK_NAME, 5, name, label)` for the prompt; poll
  `tasker.global(name)`.

### E. Deletions

- `Task.secrets`, `Project.secrets` fields; field-based aggregation.
- `requireSecret`, `MissingSecretError`, `SecretRef` in `src/tasker-api.ts`;
  their `src/index.ts` exports and tests.

### F. Docs

- README: rewrite the Secrets section — inline usage (`fmt`, `v`, bare
  `Secret`), compiler detection, ConfigProvider for scripts (with example),
  TE Config one-off mode. Fix any `%VAR`-in-string snippets.
- CLAUDE.md: update the secrets bullet + the XML exception wording
  (TE Config now also serves one-off prompts; still 3 tasks + 1 profile;
  still never user content).

### G. Tests

- Interpolation: `fmt` flattening/merging; emission
  (`"Temp: " + global("TEMPERATURE")`), bare-Secret value, `v()` local vs
  global, `Action.js` splicing; emitted files still parse (`new Function`).
- Detection: secret used via fmt / whole-value / cond is emitted; declared
  but unused secret is NOT; conflict error; If-nested and header/extras
  usage detected.
- XML: par1 one-off mode present; still 3 tasks; static guard (byte-identical
  across projects, no user names/secret names) still enforced.
- Config provider: set global resolves without prompt; missing → performTask
  recorded with name+label, poll resolves after test override sets value;
  timeout → ConfigError (use tiny pollInterval/timeout options);
  same-key concurrent reads → one performTask; secrets list supplies label.
- Remove requireSecret tests; keep/adjust cli + sync tests (secrets.json
  still emitted; counts unchanged).

## Verification & commits

- `bun run typecheck`, `bun test`, `bun run compile` all green; eyeball
  `dist-tasker/tasker-effect.prj.xml` and re-validate well-formedness.
- Logical commits, each individually green (typecheck + tests). Suggested
  split: (1) interpolation model + emission + detection + example migration,
  (2) TE Config one-off mode, (3) ConfigProvider + requireSecret removal,
  (4) docs. Author: Daniel (repo git config); NO Claude attribution or
  Co-Authored-By trailers. Do not push.
- Effect 3 only (no Effect 4 beta). No node imports reachable from
  `src/index.ts` (guard test).
