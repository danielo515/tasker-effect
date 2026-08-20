/**
 * @module compiler
 * @description Compiles profile/task definitions to plain JavaScript that
 * Tasker executes directly via its JavaScript / JavaScriptlet actions.
 *
 * The emitted code only uses Tasker's documented global functions plus
 * XMLHttpRequest (available in Tasker's WebView-based JS environment), so it
 * needs no bundler and no runtime dependencies.
 */

import { Effect, Match, Schema } from "effect";
import {
  type Action,
  type Text,
  type Trigger,
  type VolumeStream,
  Condition,
  Interpolated,
  Profile,
  Project,
  Secret,
  Task,
  VariableRef,
  isGlobalVariable,
  variableName,
  varNameOf,
} from "./profile.js";

// =============================================================================
// Errors & output types
// =============================================================================

/** A definition could not be compiled to JavaScript */
export class CompileError extends Schema.TaggedError<CompileError>()(
  "CompileError",
  {
    message: Schema.String,
    source: Schema.optional(Schema.String),
  }
) {}

/** A single compiled output file */
export interface CompiledFile {
  readonly filename: string;
  readonly content: string;
  readonly kind: "task-js" | "dispatcher-js" | "tasker-xml" | "secrets-json" | "doc";
}

/** A GitHub repository, used to embed release URLs in the bootstrap XML */
export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

/** Options for project compilation */
export interface CompileProjectOptions {
  /**
   * The GitHub repository whose rolling release the on-device bootstrap
   * downloads from. Detected from `git remote get-url origin` by the CLI, or
   * passed explicitly with `--repo owner/name`.
   */
  readonly repo: RepoRef;
}

// =============================================================================
// JS emission helpers
// =============================================================================

/** Quote a value as a JavaScript literal */
const js = (value: unknown): string => JSON.stringify(value);

/** Turn a name into a safe kebab-case file slug */
export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "task";

const indentLines = (lines: ReadonlyArray<string>, spaces: number): Array<string> => {
  const pad = " ".repeat(spaces);
  return lines.map((line) => (line === "" ? line : pad + line));
};

/** Expression reading a Tasker variable (global vs local by naming convention) */
const readVarExpr = (name: string): string =>
  isGlobalVariable(name)
    ? `global(${js(variableName(name))})`
    : `local(${js(variableName(name))})`;

/**
 * Compile a text value to a JavaScript *expression*. Plain strings become
 * literals; secrets and variable references become `global()`/`local()`
 * reads; interpolations become concatenations. Never emits `%NAME` string
 * patterns — Tasker performs no variable replacement inside JavaScript.
 */
export const emitText = (value: Text): string => {
  if (typeof value === "string") return js(value);
  if (value instanceof Secret) return `global(${js(value.name)})`;
  if (value instanceof VariableRef) return readVarExpr(value.name);
  if (value.parts.length === 0) return '""';
  return value.parts
    .map((part) =>
      typeof part === "string"
        ? js(part)
        : part instanceof Secret
          ? `global(${js(part.name)})`
          : readVarExpr(part.name)
    )
    .join(" + ");
};

/**
 * Compile raw JavaScript code: literal parts are inserted verbatim; secret
 * and variable references are spliced in as `global()`/`local()`
 * expressions.
 */
const emitJsCode = (code: Text): Array<string> => {
  if (typeof code === "string") return code.split("\n");
  if (code instanceof Interpolated) {
    return code.parts
      .map((part) =>
        typeof part === "string"
          ? part
          : part instanceof Secret
            ? `global(${js(part.name)})`
            : readVarExpr(part.name)
      )
      .join("")
      .split("\n");
  }
  return [`${emitText(code)};`];
};

/** Compile a Condition to a JavaScript boolean expression */
export const conditionExpr = (condition: Condition): string => {
  const v = readVarExpr(varNameOf(condition.variable));
  const value = condition.value ?? "";
  return Match.value(condition.op).pipe(
    Match.when("eq", () => `${v} === ${js(value)}`),
    Match.when("neq", () => `${v} !== ${js(value)}`),
    Match.when("lt", () => `parseFloat(${v}) < parseFloat(${js(value)})`),
    Match.when("gt", () => `parseFloat(${v}) > parseFloat(${js(value)})`),
    Match.when("lte", () => `parseFloat(${v}) <= parseFloat(${js(value)})`),
    Match.when("gte", () => `parseFloat(${v}) >= parseFloat(${js(value)})`),
    Match.when("contains", () => `String(${v}).indexOf(${js(value)}) !== -1`),
    Match.when("matches", () => `new RegExp(${js(value)}).test(String(${v}))`),
    Match.when("isSet", () => `(${v} !== undefined && ${v} !== "")`),
    Match.when("notSet", () => `(${v} === undefined || ${v} === "")`),
    Match.exhaustive
  );
};

// Keyed by the closed VolumeStream union so adding a stream fails typecheck
// here until a Tasker function is mapped for it.
const VOLUME_FN: Record<VolumeStream, string> = {
  alarm: "alarmVol",
  system: "systemVol",
  media: "mediaVol",
  ringer: "ringerVol",
  notification: "notificationVol",
  call: "callVol",
  dtmf: "dtmfVol",
  btvoice: "btVoiceVol",
};

const opt = (value: Text | undefined): string =>
  value === undefined ? "undefined" : emitText(value);

/** Compile one action to JavaScript source lines (unindented) */
export const emitAction = (action: Action): Array<string> =>
  Match.value(action).pipe(
    Match.tag("Flash", (a) => [
      `${a.long ? "flashLong" : "flash"}(${emitText(a.text)});`,
    ]),
    Match.tag("Popup", (a) => [
      `popup(${emitText(a.title)}, ${emitText(a.text)}, ${a.showOverKeyguard}, "", "", ${a.timeoutSecs});`,
    ]),
    Match.tag("Say", (a) => [
      `say(${emitText(a.text)}, ${opt(a.engine)}, ${opt(a.voice)}, ${js(a.stream)}, ${a.pitch}, ${a.speed});`,
    ]),
    Match.tag("Vibrate", (a) => [`vibrate(${a.milliseconds});`]),
    Match.tag("VibratePattern", (a) => [`vibratePattern(${js(a.pattern)});`]),
    Match.tag("SetGlobal", (a) => [
      `setGlobal(${js(varNameOf(a.name))}, ${emitText(a.value)});`,
    ]),
    Match.tag("SetLocal", (a) => [
      `setLocal(${js(a.name)}, ${emitText(a.value)});`,
    ]),
    // DSL task references route through the shared dispatcher: %par1 carries
    // the target task name (%par2 stays free for its exit switch), so this
    // variant cannot forward custom parameters.
    Match.tag("PerformTask", (a) => [
      `performTask(${js(DISPATCH_TASK_NAME)}, ${a.priority}, ${js(a.taskName)}, undefined);`,
    ]),
    Match.tag("PerformTaskerTask", (a) => [
      `performTask(${js(a.taskName)}, ${a.priority}, ${opt(a.parameterOne)}, ${opt(a.parameterTwo)});`,
    ]),
    Match.tag("EnableProfile", (a) => [
      `enableProfile(${js(a.profileName)}, ${a.enable});`,
    ]),
    Match.tag("Wait", (a) => [`wait(${a.milliseconds});`]),
    Match.tag("Shell", (a) => {
      const call = `shell(${emitText(a.command)}, ${a.asRoot}, ${a.timeoutSecs})`;
      if (a.outputGlobal === undefined) {
        return [`${call};`];
      }
      return [
        `__out = ${call};`,
        `setGlobal(${js(varNameOf(a.outputGlobal))}, __out === undefined ? "" : String(__out));`,
      ];
    }),
    Match.tag("ReadFile", (a) => [
      `__out = readFile(${emitText(a.path)});`,
      `setGlobal(${js(varNameOf(a.outputGlobal))}, __out === undefined ? "" : String(__out));`,
    ]),
    Match.tag("WriteFile", (a) => [
      `writeFile(${emitText(a.path)}, ${emitText(a.text)}, ${a.append});`,
    ]),
    Match.tag("HttpRequest", (a) => {
      const lines = [
        "__out = (function () {",
        "  var xhr = new XMLHttpRequest();",
        `  xhr.open(${js(a.method)}, ${emitText(a.url)}, false);`,
      ];
      for (const [key, value] of Object.entries(a.headers)) {
        lines.push(`  xhr.setRequestHeader(${js(key)}, ${emitText(value)});`);
      }
      lines.push(
        `  xhr.send(${a.body === undefined ? "null" : emitText(a.body)});`,
        "  return xhr.responseText;",
        "})();"
      );
      if (a.outputGlobal !== undefined) {
        lines.push(`setGlobal(${js(varNameOf(a.outputGlobal))}, __out);`);
      }
      return lines;
    }),
    Match.tag("BrowseUrl", (a) => [`browseURL(${emitText(a.url)});`]),
    Match.tag("SendSms", (a) => [
      `sendSMS(${emitText(a.number)}, ${emitText(a.text)}, ${a.storeInMessagingApp});`,
    ]),
    Match.tag("SetWifi", (a) => [`setWifi(${a.on});`])
  ).pipe(
    Match.tag("SetBluetooth", (a) => [`setBT(${a.on});`]),
    Match.tag("SetAirplaneMode", (a) => [`setAirplaneMode(${a.on});`]),
    Match.tag("SetMobileData", (a) => [`mobileData(${a.on});`]),
    Match.tag("SetAutoSync", (a) => [`setAutoSync(${a.on});`]),
    Match.tag("SetVolume", (a) => [
      `${VOLUME_FN[a.stream]}(${a.level}, ${a.display}, ${a.sound});`,
    ]),
    Match.tag("MediaControl", (a) => [`mediaControl(${js(a.action)});`]),
    Match.tag("MusicPlay", (a) => [
      `musicPlay(${emitText(a.path)}, ${a.offsetSecs}, ${a.loop}, ${js(a.stream)});`,
    ]),
    Match.tag("MusicStop", () => ["musicStop();"]),
    Match.tag("SetClip", (a) => [`setClip(${emitText(a.text)}, ${a.append});`]),
    Match.tag("SetWallpaper", (a) => [`setWallpaper(${emitText(a.path)});`]),
    Match.tag("LaunchApp", (a) => [
      `loadApp(${emitText(a.app)}, ${opt(a.data)}, ${a.excludeFromRecents});`,
    ]),
    Match.tag("SendIntent", (a) => {
      const extras = `[${a.extras.map((extra) => emitText(extra)).join(", ")}]`;
      return [
        `sendIntent(${js(a.action)}, ${js(a.targetComp)}, ${opt(a.pkg)}, ${opt(a.cls)}, ${opt(a.category)}, ${opt(a.data)}, ${opt(a.mimeType)}, ${extras});`,
      ];
    }),
    Match.tag("SetSilentMode", (a) => [`silentMode(${js(a.mode)});`]),
    Match.tag("GoHome", (a) => [`goHome(${a.screen});`]),
    Match.tag("GetLocation", (a) => [
      `getLocation(${js(a.source)}, ${a.keepTracking}, ${a.timeoutSecs});`,
    ]),
    Match.tag("JavaScript", (a) => emitJsCode(a.code)),
    Match.tag("If", (a) => {
      const lines = [`if (${conditionExpr(a.condition)}) {`];
      for (const inner of a.then) {
        lines.push(...indentLines(emitAction(inner), 2));
      }
      if (a.orElse.length > 0) {
        lines.push("} else {");
        for (const inner of a.orElse) {
          lines.push(...indentLines(emitAction(inner), 2));
        }
      }
      lines.push("}");
      return lines;
    }),
    Match.exhaustive
  );

// =============================================================================
// Task / Profile / Project compilation
// =============================================================================

const header = (title: string, description?: string): Array<string> => [
  "/**",
  ` * ${title}`,
  ...(description !== undefined ? [` * ${description}`] : []),
  " *",
  " * Generated by tasker-effect. Do not edit by hand.",
  " * Run in Tasker with a JavaScript action pointing at this file.",
  " */",
];

/** Compile a task to a standalone JavaScript source string */
export const compileTaskToJs = (task: Task): string => {
  const body = task.actions.flatMap((action) => indentLines(emitAction(action), 4));
  return [
    ...header(`Task: ${task.name}`, task.description),
    '"use strict";',
    "(function () {",
    "  var __out;",
    "  try {",
    ...body,
    "  } catch (err) {",
    `    flash(${js(`Task "${task.name}" failed: `)} + err);`,
    "  }",
    "})();",
    "",
  ].join("\n");
};

/** Human-readable description of a trigger for setup instructions */
export const describeTrigger = (trigger: Trigger): string =>
  Match.value(trigger).pipe(
    Match.tag("TimeTrigger", (t) => {
      const fmt = (time: { hour: number; minute: number }) =>
        `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
      const parts = [`Time from ${fmt(t.from)}`];
      if (t.to !== undefined) parts.push(`to ${fmt(t.to)}`);
      if (t.repeatMinutes !== undefined) parts.push(`every ${t.repeatMinutes}m`);
      if (t.days.length > 0) parts.push(`on ${t.days.join(", ")}`);
      return parts.join(" ");
    }),
    Match.tag(
      "LocationTrigger",
      (t) =>
        `Location within ${t.radiusMeters}m of ${t.latitude}, ${t.longitude}`
    ),
    Match.tag(
      "WifiConnectedTrigger",
      (t) => `State > Net > Wifi Connected (SSID: ${t.ssid})`
    ),
    Match.tag(
      "BluetoothConnectedTrigger",
      (t) => `State > Net > BT Connected (Name: ${t.name})`
    ),
    Match.tag("AppOpenedTrigger", (t) => `Application: ${t.app}`),
    Match.tag(
      "BatteryLevelTrigger",
      (t) => `State > Power > Battery Level from ${t.from}% to ${t.to}%`
    ),
    Match.tag(
      "VariableTrigger",
      (t) =>
        `State > Variables > Variable Value: %${t.condition.variable} ${t.condition.op} ${t.condition.value ?? ""}`
    ),
    Match.tag(
      "EventTrigger",
      (t) =>
        `Event: ${t.event}${t.parameter !== undefined ? ` (${t.parameter})` : ""}`
    ),
    Match.tag(
      "StateTrigger",
      (t) =>
        `State: ${t.state}${t.parameter !== undefined ? ` (${t.parameter})` : ""}`
    ),
    Match.exhaustive
  );

/** Compile a profile: one JS file per enter/exit task */
export const compileProfileFiles = (profile: Profile): Array<CompiledFile> => {
  const slug = slugify(profile.name);
  const files: Array<CompiledFile> = [
    {
      filename: `${slug}.enter.js`,
      content: compileTaskToJs(profile.enter),
      kind: "task-js",
    },
  ];
  if (profile.exit !== undefined) {
    files.push({
      filename: `${slug}.exit.js`,
      content: compileTaskToJs(profile.exit),
      kind: "task-js",
    });
  }
  return files;
};

const profileReadmeSection = (profile: Profile): string => {
  const slug = slugify(profile.name);
  const lines = [
    `### Profile: ${profile.name}`,
    "",
    ...(profile.description !== undefined ? [profile.description, ""] : []),
    "Triggers to configure in the Tasker UI:",
    "",
    ...profile.triggers.map((trigger) => `- ${describeTrigger(trigger)}`),
    "",
    `- Enter task: JavaScript action → \`${slug}.enter.js\``,
    ...(profile.exit !== undefined
      ? [`- Exit task: JavaScript action → \`${slug}.exit.js\``]
      : []),
    "",
  ];
  return lines.join("\n");
};

// =============================================================================
// Dispatcher (single JS entry point) + importable task XML scaffolding
// =============================================================================

/** Directory on the device where synced JS files live by default */
export const DEFAULT_DEVICE_JS_DIR = "/sdcard/Tasker/js/";

/** Filename of the generated dispatcher */
export const DISPATCHER_FILENAME = "dispatcher.js";

/** Filename of the importable Tasker project XML */
export const TASKER_PROJECT_XML_FILENAME = "tasker-effect.prj.xml";

/** Name of the shared dispatch task created by the import XML */
export const DISPATCH_TASK_NAME = "TE Dispatch";

/** Name of the self-bootstrapping sync task created by the import XML */
export const SYNC_TASK_NAME = "TE Sync";

/** Name of the secrets-prompting task created by the import XML */
export const CONFIG_TASK_NAME = "TE Config";

/** Name of the periodic sync profile created by the import XML */
export const SYNC_PROFILE_NAME = "TE Sync";

/**
 * Compile the dispatcher: a single JS file that resolves which compiled file
 * should run and `eval`s it. Resolution order:
 *
 * 1. Explicit `%par1` (a profile or task name from the embedded map), with
 *    `%par2` = "exit" selecting a profile's exit file.
 * 2. Caller detection via Tasker's `%caller1` local variable, which for
 *    profile-launched tasks has the form `profile=enter:<name>` or
 *    `profile=exit:<name>` (verified against the Tasker variables userguide:
 *    "callername is either enter or exit depending on whether the profile
 *    activated or deactivated; subcallername is the name of the profile").
 *
 * The base directory defaults to /sdcard/Tasker/js/ and can be overridden
 * with the Tasker global %TE_JS_DIR.
 */
export const compileDispatcherJs = (project: Project): string => {
  const profileEntries = project.profiles.map((profile) => {
    const slug = slugify(profile.name);
    const exitPart =
      profile.exit !== undefined ? `, exit: ${js(`${slug}.exit.js`)}` : "";
    return `    ${js(profile.name)}: { enter: ${js(`${slug}.enter.js`)}${exitPart} },`;
  });
  const taskEntries = project.tasks.map(
    (task) => `    ${js(task.name)}: ${js(`${slugify(task.name)}.js`)},`
  );

  return [
    ...header(
      `Dispatcher: ${project.name}`,
      "Single entry point that runs the mapped file for the calling profile or %par1."
    ),
    '"use strict";',
    "(function () {",
    "  var PROFILES = {",
    ...profileEntries,
    "  };",
    "  var TASKS = {",
    ...taskEntries,
    "  };",
    "  try {",
    '    var base = global("TE_JS_DIR");',
    `    if (base === undefined || base === "") base = ${js(DEFAULT_DEVICE_JS_DIR)};`,
    '    if (base.charAt(base.length - 1) !== "/") base = base + "/";',
    "",
    '    var par1 = local("par1");',
    '    var par2 = local("par2");',
    "    var target;",
    '    if (par1 !== undefined && par1 !== "") {',
    '      var wantExit = par2 !== undefined && String(par2).toLowerCase() === "exit";',
    "      if (PROFILES.hasOwnProperty(par1)) {",
    "        target = wantExit ? PROFILES[par1].exit : PROFILES[par1].enter;",
    "        if (target === undefined) {",
    '          flash("tasker-effect dispatch: profile \\"" + par1 + "\\" has no " + (wantExit ? "exit" : "enter") + " task");',
    "          return;",
    "        }",
    "      } else if (TASKS.hasOwnProperty(par1)) {",
    "        target = TASKS[par1];",
    "      } else {",
    '        flash("tasker-effect dispatch: unknown profile or task \\"" + par1 + "\\"");',
    "        return;",
    "      }",
    "    } else {",
    '      // %caller1 is "profile=enter:<name>" / "profile=exit:<name>" when a',
    "      // profile state change launched this task.",
    '      var caller = local("caller1");',
    '      var match = /^profile=(enter|exit):([\\s\\S]+)$/.exec(caller === undefined ? "" : caller);',
    "      if (match === null) {",
    '        flash("tasker-effect dispatch: no %par1 given and caller is not a profile (%caller1=" + caller + ")");',
    "        return;",
    "      }",
    "      var entry = PROFILES[match[2]];",
    "      if (entry === undefined) {",
    '        flash("tasker-effect dispatch: unknown profile \\"" + match[2] + "\\"");',
    "        return;",
    "      }",
    '      target = match[1] === "exit" ? entry.exit : entry.enter;',
    "      if (target === undefined) {",
    '        flash("tasker-effect dispatch: profile \\"" + match[2] + "\\" has no " + match[1] + " task");',
    "        return;",
    "      }",
    "    }",
    "",
    "    var path = base + target;",
    "    var source = readFile(path);",
    '    if (source === undefined || source === "") {',
    '      flash("tasker-effect dispatch: could not read " + path);',
    "      return;",
    "    }",
    "    eval(source);",
    "  } catch (err) {",
    '    flash("tasker-effect dispatch failed: " + err);',
    "  }",
    "})();",
    "",
  ].join("\n");
};

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// --- Static XML scaffolding ---------------------------------------------------
//
// XML structure verified against real Tasker exports and the Taskomater
// Tasker-XML-Info action code list. `.prj.xml` layout: <TaskerData> holds
// <Profile>, <Project> and <Task> elements as siblings; <Project> lists its
// member profile/task ids in comma-separated <pids>/<tids>. Action codes
// used here: 131 JavaScript (file), 129 JavaScriptlet (inline), 37 If /
// 38 End If (condition op 12 = "Is Set"), 39 For / 40 End For (items split
// on commas), 360 Input Dialog (result lands in %input). A Time context
// repeating every N hours is <rep>1</rep><repval>N</repval> with -1
// from/to fields.

/** Rolling GitHub release tag that CI keeps pointed at the newest build */
export const ROLLING_RELEASE_TAG = "tasker-js-latest";

/** Filename of the bundled on-device sync script */
export const SYNC_SCRIPT_FILENAME = "sync-profiles.js";

/** How often the TE Sync profile fires, in hours */
export const SYNC_REPEAT_HOURS = 6;

/**
 * Shared preamble for the inline JavaScriptlets: resolve the device JS
 * directory (same convention as the dispatcher: %TE_JS_DIR overrides the
 * default).
 */
const jsDirPreamble = (jsDir: string): Array<string> => [
  'var dir = global("TE_JS_DIR");',
  `if (dir === undefined || dir === "") dir = ${js(jsDir)};`,
  'if (dir.charAt(dir.length - 1) !== "/") dir = dir + "/";',
];

/**
 * Bootstrap snippet inside the `TE Sync` task: run the synced
 * sync-profiles.js if present, otherwise self-install it from the rolling
 * GitHub release with a synchronous XHR first. Always queues `TE Config`
 * so newly declared secrets get prompted for after every sync.
 *
 * A GitHub token in the Tasker global %TE_GH_TOKEN is sent as an
 * Authorization header when set (not needed for public repos).
 */
export const syncBootstrapJs = (
  repo: RepoRef,
  jsDir: string = DEFAULT_DEVICE_JS_DIR
): string => {
  const url = `https://github.com/${repo.owner}/${repo.repo}/releases/download/${ROLLING_RELEASE_TAG}/${SYNC_SCRIPT_FILENAME}`;
  return [
    ...jsDirPreamble(jsDir),
    `var path = dir + ${js(SYNC_SCRIPT_FILENAME)};`,
    "var source = readFile(path);",
    'if (source === undefined || source === "") {',
    "  var xhr = new XMLHttpRequest();",
    `  xhr.open("GET", ${js(url)}, false);`,
    '  var token = global("TE_GH_TOKEN");',
    '  if (token !== undefined && token !== "") xhr.setRequestHeader("Authorization", "Bearer " + token);',
    "  xhr.send(null);",
    '  if (xhr.status !== 200 || xhr.responseText === "") {',
    `    flash("tasker-effect bootstrap: downloading ${SYNC_SCRIPT_FILENAME} failed (HTTP " + xhr.status + ")");`,
    "    exit();",
    "  }",
    "  source = xhr.responseText;",
    "  writeFile(path, source, false);",
    "}",
    // Queued before the eval: the sync script completes asynchronously (and
    // calls exit() itself), so there is no "after sync" statement to hook.
    // TE Config tolerates the race by waiting for secrets.json on first run.
    `performTask(${js(CONFIG_TASK_NAME)}, 5);`,
    "eval(source);",
  ].join("\n");
};

/**
 * First action of `TE Config`, two modes:
 *
 * - **One-off** (`%par1` set, e.g. performed by the Tasker ConfigProvider):
 *   prompt for exactly that global when it is unset, using `%par2` as the
 *   dialog label when given.
 * - **Scan** (no `%par1`, after every sync): read secrets.json (waiting up
 *   to 30s for the first sync to deliver it) and collect the declared
 *   secrets whose Tasker global is unset or empty.
 *
 * Either way the names to prompt for land in the comma-separated local
 * %te_missing (left unset when nothing is missing, so the If guard skips
 * the prompt loop).
 */
export const configScanJs = (jsDir: string = DEFAULT_DEVICE_JS_DIR): string =>
  [
    ...jsDirPreamble(jsDir),
    'var par1 = local("par1");',
    'if (par1 !== undefined && par1 !== "") {',
    "  var current = global(par1);",
    '  if (current === undefined || current === "") {',
    '    setLocal("te_missing", par1);',
    '    var par2 = local("par2");',
    '    if (par2 !== undefined && par2 !== "") setLocal("te_label", par2);',
    "  }",
    "  exit();",
    "}",
    "var tries = 0;",
    "function scan() {",
    `  var raw = readFile(dir + ${js(SECRETS_FILENAME)});`,
    '  if ((raw === undefined || raw === "") && tries < 15) {',
    "    tries = tries + 1;",
    "    setTimeout(scan, 2000);",
    "    return;",
    "  }",
    "  var missing = [];",
    "  try {",
    "    var declared = JSON.parse(raw);",
    "    for (var i = 0; i < declared.length; i++) {",
    "      var value = global(declared[i].name);",
    '      if (value === undefined || value === "") missing.push(declared[i].name);',
    "    }",
    "  } catch (err) {}",
    '  if (missing.length > 0) setLocal("te_missing", missing.join(","));',
    "  exit();",
    "}",
    "scan();",
  ].join("\n");

/**
 * Loop body of `TE Config`: resolve the human-readable prompt label for the
 * current secret (%te_secret) into %te_prompt — an explicit %te_label (set
 * by the one-off mode) wins, else the secrets.json description, else the
 * name itself.
 */
const configLabelJs = (jsDir: string): string =>
  [
    ...jsDirPreamble(jsDir),
    'var label = local("te_label");',
    'if (label === undefined || label === "") {',
    '  label = local("te_secret");',
    "  try {",
    `    var declared = JSON.parse(readFile(dir + ${js(SECRETS_FILENAME)}));`,
    "    for (var i = 0; i < declared.length; i++) {",
    "      if (declared[i].name === label && declared[i].description) {",
    "        label = declared[i].description;",
    "        break;",
    "      }",
    "    }",
    "  } catch (err) {}",
    "}",
    'setLocal("te_prompt", label);',
  ].join("\n");

/**
 * Loop tail of `TE Config`: store the Input Dialog answer (%input) into the
 * Tasker global named by the current secret. A JavaScriptlet because Tasker's
 * Variable Set cannot target a dynamically named global.
 */
const configStoreJs = 'setGlobal(local("te_secret"), local("input"));';

// --- XML emission helpers ---

const strArg = (index: number, value: string): string =>
  value === ""
    ? `\t\t\t<Str sr="arg${index}" ve="3"/>`
    : `\t\t\t<Str sr="arg${index}" ve="3">${escapeXml(value)}</Str>`;

const intArg = (index: number, value: number): string =>
  `\t\t\t<Int sr="arg${index}" val="${value}"/>`;

const xmlAction = (
  index: number,
  code: number,
  body: ReadonlyArray<string>
): Array<string> => [
  `\t\t<Action sr="act${index}" ve="7">`,
  `\t\t\t<code>${code}</code>`,
  ...body,
  "\t\t</Action>",
];

/** Inline JavaScriptlet action (code 129) */
const scriptletAction = (
  index: number,
  code: string,
  options: { readonly autoExit: boolean; readonly timeoutSecs: number }
): Array<string> =>
  xmlAction(index, 129, [
    strArg(0, code),
    strArg(1, ""),
    intArg(2, options.autoExit ? 1 : 0),
    intArg(3, options.timeoutSecs),
  ]);

const xmlTask = (
  id: number,
  name: string,
  actions: ReadonlyArray<string>
): Array<string> => [
  `\t<Task sr="task${id}">`,
  "\t\t<cdate>1</cdate>",
  `\t\t<id>${id}</id>`,
  `\t\t<nme>${escapeXml(name)}</nme>`,
  ...actions,
  "\t</Task>",
];

const DISPATCH_TASK_ID = 1;
const SYNC_TASK_ID = 2;
const CONFIG_TASK_ID = 3;
const SYNC_PROFILE_ID = 4;

/** Options for the generated project XML */
export interface TaskerProjectXmlOptions {
  /** Repository whose rolling release the bootstrap downloads from */
  readonly repo: RepoRef;
  /** Path of the dispatcher file on the device */
  readonly dispatcherPath?: string;
  /** Device directory holding the synced JS files */
  readonly jsDir?: string;
}

/**
 * Importable Tasker **project** XML (`.prj.xml`) holding the complete static
 * scaffolding, so onboarding is: import once, enable, done.
 *
 * - Task `TE Dispatch`: file-based JavaScript action (131) running the
 *   dispatcher.
 * - Task `TE Sync`: inline JavaScriptlet (129) that runs the synced
 *   sync-profiles.js, self-installing it from the rolling GitHub release on
 *   first run, then queues `TE Config`.
 * - Task `TE Config`: prompts (Input Dialog, 360) for every secret declared
 *   in secrets.json whose Tasker global is still unset.
 * - Profile `TE Sync`: Time context repeating every 6 hours, enter task
 *   `TE Sync`.
 *
 * The XML is static scaffolding for a one-time import: it never embeds
 * compiled logic, task names or secret names from the user's project — only
 * the pointer to the dispatcher and the embedded repository slug.
 */
export const taskerProjectXml = (options: TaskerProjectXmlOptions): string => {
  const jsDir = options.jsDir ?? DEFAULT_DEVICE_JS_DIR;
  const dispatcherPath =
    options.dispatcherPath ?? `${jsDir}${DISPATCHER_FILENAME}`;

  const isSetCondition = (variable: string): Array<string> => [
    '\t\t\t<ConditionList sr="if">',
    '\t\t\t\t<Condition sr="c0" ve="3">',
    `\t\t\t\t\t<lhs>${escapeXml(variable)}</lhs>`,
    "\t\t\t\t\t<op>12</op>",
    "\t\t\t\t\t<rhs></rhs>",
    "\t\t\t\t</Condition>",
    "\t\t\t</ConditionList>",
  ];

  return [
    '<TaskerData sr="" dvi="1" tv="6.3.13">',
    // Profile: periodic sync trigger → TE Sync task.
    `\t<Profile sr="prof${SYNC_PROFILE_ID}" ve="2">`,
    "\t\t<cdate>1</cdate>",
    `\t\t<id>${SYNC_PROFILE_ID}</id>`,
    `\t\t<mid0>${SYNC_TASK_ID}</mid0>`,
    `\t\t<nme>${escapeXml(SYNC_PROFILE_NAME)}</nme>`,
    '\t\t<Time sr="con0">',
    "\t\t\t<fh>-1</fh>",
    "\t\t\t<fm>-1</fm>",
    `\t\t\t<rep>1</rep>`,
    `\t\t\t<repval>${SYNC_REPEAT_HOURS}</repval>`,
    "\t\t\t<th>-1</th>",
    "\t\t\t<tm>-1</tm>",
    "\t\t</Time>",
    "\t</Profile>",
    // Project element tying the pieces together.
    '\t<Project sr="proj0" ve="2">',
    "\t\t<cdate>1</cdate>",
    "\t\t<name>Tasker Effect</name>",
    `\t\t<pids>${SYNC_PROFILE_ID}</pids>`,
    `\t\t<tids>${DISPATCH_TASK_ID},${SYNC_TASK_ID},${CONFIG_TASK_ID}</tids>`,
    "\t</Project>",
    // TE Dispatch: run the dispatcher file (Auto Exit on).
    ...xmlTask(DISPATCH_TASK_ID, DISPATCH_TASK_NAME, [
      ...xmlAction(0, 131, [
        strArg(0, dispatcherPath),
        strArg(1, ""),
        intArg(2, 1),
        intArg(3, 45),
      ]),
    ]),
    // TE Sync: self-bootstrapping sync (Auto Exit off — the evaluated sync
    // script finishes asynchronously and calls exit() itself).
    ...xmlTask(SYNC_TASK_ID, SYNC_TASK_NAME, [
      ...scriptletAction(0, syncBootstrapJs(options.repo, jsDir), {
        autoExit: false,
        timeoutSecs: 180,
      }),
    ]),
    // TE Config: prompt for declared-but-unset secrets.
    ...xmlTask(CONFIG_TASK_ID, CONFIG_TASK_NAME, [
      ...scriptletAction(0, configScanJs(jsDir), {
        autoExit: false,
        timeoutSecs: 120,
      }),
      ...xmlAction(1, 37, isSetCondition("%te_missing")),
      ...xmlAction(2, 39, [
        strArg(0, "%te_secret"),
        strArg(1, "%te_missing"),
        intArg(2, 0),
      ]),
      ...scriptletAction(3, configLabelJs(jsDir), {
        autoExit: true,
        timeoutSecs: 45,
      }),
      ...xmlAction(4, 360, [
        strArg(1, "%te_secret"),
        strArg(2, "%te_prompt"),
        strArg(3, ""),
        intArg(4, 999),
        strArg(5, "229457"),
        intArg(6, 0),
        intArg(7, 0),
      ]),
      ...scriptletAction(5, configStoreJs, {
        autoExit: true,
        timeoutSecs: 45,
      }),
      ...xmlAction(6, 40, []),
      ...xmlAction(7, 38, []),
    ]),
    "</TaskerData>",
    "",
  ].join("\n");
};

const dispatcherReadmeSection = (project: Project): Array<string> => [
  "## One-time setup",
  "",
  `1. Import \`${TASKER_PROJECT_XML_FILENAME}\` once in Tasker (long-press the home`,
  "   icon at the bottom left → Import Project). This creates the shared task",
  `   \`${DISPATCH_TASK_NAME}\`, the self-bootstrapping \`${SYNC_TASK_NAME}\` task with its periodic`,
  `   profile, and the \`${CONFIG_TASK_NAME}\` secrets prompter. Enable the \`${SYNC_PROFILE_NAME}\``,
  "   profile (or run the task once) and it downloads everything else by",
  "   itself — no files need to be copied manually.",
  "2. For each profile below, configure its trigger(s) in the Tasker UI and",
  `   set both the enter and the exit task to \`${DISPATCH_TASK_NAME}\`. The dispatcher`,
  "   detects the calling profile from `%caller1` (`profile=enter:<name>` /",
  "   `profile=exit:<name>`) and runs the matching file.",
  ...(project.tasks.length > 0
    ? [
        `3. Run standalone tasks with Perform Task → \`${DISPATCH_TASK_NAME}\`, passing the`,
        "   task name as `%par1` (use `%par2` = `exit` to force a profile's exit",
        "   file when calling explicitly).",
      ]
    : []),
  "",
  "The dispatcher reads files from `" + DEFAULT_DEVICE_JS_DIR + "`; override with",
  "the Tasker global `%TE_JS_DIR` (then also edit the path in the imported",
  "task).",
  "",
];

// =============================================================================
// Secrets manifest
// =============================================================================

/** Filename of the aggregated secrets manifest */
export const SECRETS_FILENAME = "secrets.json";

/**
 * Recursively find every {@link Secret} referenced inside a value: whole
 * field values, interpolation parts, condition variables, header records,
 * extras arrays and nested `If` branches are all reached by walking the
 * plain data of the action tree.
 */
const walkSecrets = (
  node: unknown,
  visit: (secret: Secret) => void,
  seen: Set<object>
): void => {
  if (node instanceof Secret) {
    visit(node);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) walkSecrets(item, visit, seen);
    return;
  }
  for (const value of Object.values(node)) walkSecrets(value, visit, seen);
};

/**
 * Collect every secret *used* anywhere in the project's action trees
 * (profiles' enter/exit tasks and standalone tasks), deduplicated by name.
 * Secrets are detected at their use sites — a declared but unused secret is
 * not emitted. The same name with two different descriptions is a conflict
 * and fails compilation.
 */
export const collectProjectSecrets = (project: Project): Array<Secret> => {
  const byName = new Map<string, Secret>();
  const addFrom = (owner: string, task: Task): void => {
    walkSecrets(
      task.actions,
      (secret) => {
        const existing = byName.get(secret.name);
        if (existing === undefined) {
          byName.set(secret.name, secret);
          return;
        }
        if (existing.description !== secret.description) {
          throw new CompileError({
            message:
              `Secret "${secret.name}" is used with two different descriptions: ` +
              `"${existing.description}" vs "${secret.description}" (${owner})`,
            source: project.name,
          });
        }
      },
      new Set()
    );
  };
  for (const profile of project.profiles) {
    addFrom(`profile "${profile.name}" enter task`, profile.enter);
    if (profile.exit !== undefined) {
      addFrom(`profile "${profile.name}" exit task`, profile.exit);
    }
  }
  for (const task of project.tasks) {
    addFrom(`task "${task.name}"`, task);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * The secrets manifest shipped with the release assets and synced to the
 * device. `TE Config` reads it after every sync and prompts only for entries
 * whose Tasker global is still unset. Always emitted (even when empty) so
 * the on-device state can converge after secrets are removed.
 */
export const compileSecretsJson = (project: Project): string =>
  `${JSON.stringify(
    collectProjectSecrets(project).map(({ name, description }) => ({
      name,
      description,
    })),
    null,
    2
  )}\n`;

// =============================================================================
// Linker check (Project-level)
// =============================================================================

/** Collect every DSL `PerformTask` reference in an action tree */
const collectTaskRefs = (actions: ReadonlyArray<Action>): Array<string> => {
  const refs: Array<string> = [];
  const walk = (action: Action): void => {
    if (action._tag === "PerformTask") {
      refs.push(action.taskName);
    } else if (action._tag === "If") {
      action.then.forEach(walk);
      action.orElse.forEach(walk);
    }
  };
  actions.forEach(walk);
  return refs;
};

/**
 * Fail compilation if any DSL `PerformTask` references a task that is not in
 * `project.tasks` — those are the only names the dispatcher's task map knows.
 * Only Project compilation can run this check: a standalone task or profile
 * has no surrounding project to resolve references against.
 */
const checkTaskReferences = (project: Project): void => {
  const targets = project.tasks.map((task) => task.name);
  const targetList =
    targets.length > 0 ? targets.map((name) => `"${name}"`).join(", ") : "(none)";
  const check = (owner: string, task: Task): void => {
    for (const ref of collectTaskRefs(task.actions)) {
      if (!targets.includes(ref)) {
        throw new CompileError({
          message: `${owner} references unknown task "${ref}". Valid targets: ${targetList}`,
          source: project.name,
        });
      }
    }
  };
  for (const profile of project.profiles) {
    check(`Profile "${profile.name}" enter task "${profile.enter.name}"`, profile.enter);
    if (profile.exit !== undefined) {
      check(`Profile "${profile.name}" exit task "${profile.exit.name}"`, profile.exit);
    }
  }
  for (const task of project.tasks) {
    check(`Task "${task.name}"`, task);
  }
};

/** Compile a whole project to JS files plus a setup README */
export const compileProjectFiles = (
  project: Project,
  options: CompileProjectOptions
): Array<CompiledFile> => {
  checkTaskReferences(project);
  const files: Array<CompiledFile> = [];
  for (const profile of project.profiles) {
    files.push(...compileProfileFiles(profile));
  }
  for (const task of project.tasks) {
    files.push({
      filename: `${slugify(task.name)}.js`,
      content: compileTaskToJs(task),
      kind: "task-js",
    });
  }
  files.push({
    filename: DISPATCHER_FILENAME,
    content: compileDispatcherJs(project),
    kind: "dispatcher-js",
  });
  files.push({
    filename: SECRETS_FILENAME,
    content: compileSecretsJson(project),
    kind: "secrets-json",
  });
  files.push({
    filename: TASKER_PROJECT_XML_FILENAME,
    content: taskerProjectXml({ repo: options.repo }),
    kind: "tasker-xml",
  });

  const readme = [
    `# ${project.name}`,
    "",
    ...(project.description !== undefined ? [project.description, ""] : []),
    "Compiled with tasker-effect. Copy the `.js` files to your device (e.g.",
    "`/sdcard/Tasker/js/`) and point Tasker JavaScript actions at them —",
    "or import the dispatcher task once and skip per-task actions entirely:",
    "",
    "## Files",
    "",
    ...files.map((file) => `- \`${file.filename}\``),
    "",
    ...dispatcherReadmeSection(project),
    ...(project.profiles.length > 0 ? ["## Profiles", ""] : []),
    ...project.profiles.map(profileReadmeSection),
    ...(project.tasks.length > 0
      ? [
          "## Standalone tasks",
          "",
          ...project.tasks.map(
            (task) =>
              `- ${task.name}: \`${slugify(task.name)}.js\`${task.description !== undefined ? ` — ${task.description}` : ""}`
          ),
          "",
        ]
      : []),
  ].join("\n");

  files.push({ filename: "README.md", content: readme, kind: "doc" });
  return files;
};

// =============================================================================
// Compiler service
// =============================================================================

const tryCompile = <A>(run: () => A, source: string): Effect.Effect<A, CompileError> =>
  Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof CompileError
        ? cause
        : new CompileError({ message: String(cause), source }),
  });

/**
 * Effect service around the pure compiler functions, for use in build
 * pipelines composed with other services.
 */
export class TaskerCompiler extends Effect.Service<TaskerCompiler>()(
  "TaskerCompiler",
  {
    sync: () => ({
      compileTask: (task: Task): Effect.Effect<CompiledFile, CompileError> =>
        tryCompile(
          () => ({
            filename: `${slugify(task.name)}.js`,
            content: compileTaskToJs(task),
            kind: "task-js" as const,
          }),
          task.name
        ),
      compileProfile: (
        profile: Profile
      ): Effect.Effect<Array<CompiledFile>, CompileError> =>
        tryCompile(() => compileProfileFiles(profile), profile.name),
      compileProject: (
        project: Project,
        options: CompileProjectOptions
      ): Effect.Effect<Array<CompiledFile>, CompileError> =>
        tryCompile(() => compileProjectFiles(project, options), project.name),
    }),
  }
) {}
