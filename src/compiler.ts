/**
 * @module compiler
 * @description Compiles profile/task definitions to plain JavaScript that
 * Tasker executes directly via its JavaScript / JavaScriptlet actions.
 *
 * The emitted code only uses Tasker's documented global functions plus
 * XMLHttpRequest (available in Tasker's WebView-based JS environment), so it
 * needs no bundler and no runtime dependencies.
 */

import { Array as Arr, Effect, Match, Order, Schema } from "effect";
import {
  type Action,
  type AppOpenedTrigger,
  type ClipboardChangedTrigger,
  type JsCode,
  type ShowScene,
  type Text,
  type Trigger,
  type VolumeStream,
  Condition,
  Profile,
  Project,
  SCENE_JS_DIR_PLACEHOLDER,
  Secret,
  Task,
  VariableRef,
  isGlobalVariable,
  variableName,
  varNameOf,
} from "./profile.js";
import {
  MENU_HTML_FILENAME,
  MENU_SCENE_FILENAME,
  MENU_SCRIPT_FILENAME,
  MENU_TASK_NAME,
  menuHtml,
  menuSceneJson,
  menuScriptJs,
} from "./menu.js";

// =============================================================================
// Errors & output types
// =============================================================================

/** A definition could not be compiled to JavaScript */
export class CompileError extends Schema.TaggedError<CompileError>()(
  "CompileError",
  {
    message: Schema.String,
    source: Schema.optional(Schema.String),
  },
) {}

/** A single compiled output file */
export interface CompiledFile {
  readonly filename: string;
  readonly content: string;
  readonly kind:
    | "task-js"
    | "dispatcher-js"
    | "scaffold-js"
    | "tasker-xml"
    | "secrets-json"
    | "web-asset"
    | "doc";
}

/** A GitHub repository, used to embed release URLs in the bootstrap XML */
export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

/** Options for project compilation */
export interface CompileProjectOptions {
  /**
   * The GitHub repository whose rolling release the on-device TE Sync task
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

/**
 * Sanitize a user-supplied string for interpolation into a `/** ... *\/`
 * block comment: a `*\/` inside a name/description would otherwise close the
 * comment early, either breaking the file or escaping into live top-level
 * code, and a newline would otherwise let the string smuggle its own
 * comment-close sequence across lines.
 */
const commentSafe = (v: string): string =>
  v.replace(/\*\//g, "*\\/").replace(/[\r\n]+/g, " ");

/** Turn a name into a safe kebab-case file slug */
export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "task";

const indentLines = (
  lines: ReadonlyArray<string>,
  spaces: number,
): Array<string> => {
  const pad = " ".repeat(spaces);
  return lines.map((line) => (line === "" ? line : pad + line));
};

/**
 * Expression reading a Tasker variable. An explicit `scope` (set by
 * {@link VariableRef}'s `l()`/`v()` builders) wins; otherwise falls back to
 * the {@link isGlobalVariable} naming heuristic, which cannot separate a
 * user global from an all-caps built-in Tasker local (e.g. the SMS event's
 * `%SMSRF`).
 */
const readVarExpr = (name: string, scope?: "global" | "local"): string =>
  (scope ?? (isGlobalVariable(name) ? "global" : "local")) === "global"
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
  if (value instanceof VariableRef) return readVarExpr(value.name, value.scope);
  return value.parts
    .map((part) =>
      typeof part === "string"
        ? js(part)
        : part instanceof Secret
          ? `global(${js(part.name)})`
          : readVarExpr(part.name, part.scope),
    )
    .join(" + ");
};

/**
 * Compile raw JavaScript code: literal parts are inserted verbatim; secret
 * and variable references are spliced in as `global()`/`local()`
 * expressions.
 */
const emitJsCode = (code: JsCode): Array<string> =>
  typeof code === "string"
    ? code.split("\n")
    : code.parts
        .map((part) =>
          typeof part === "string"
            ? part
            : part instanceof Secret
              ? `global(${js(part.name)})`
              : readVarExpr(part.name, part.scope),
        )
        .join("")
        .split("\n");

/** Compile a Condition to a JavaScript boolean expression */
export const conditionExpr = (condition: Condition): string => {
  const v = readVarExpr(varNameOf(condition.variable));
  // Matching on the whole condition (not just `op`) narrows the union, so
  // `c.value` is a required string in every comparison arm — there is no
  // missing comparand to paper over with "".
  return Match.value(condition).pipe(
    Match.when({ op: "eq" }, (c) => `${v} === ${js(c.value)}`),
    Match.when({ op: "neq" }, (c) => `${v} !== ${js(c.value)}`),
    Match.when(
      { op: "lt" },
      (c) => `parseFloat(${v}) < parseFloat(${js(c.value)})`,
    ),
    Match.when(
      { op: "gt" },
      (c) => `parseFloat(${v}) > parseFloat(${js(c.value)})`,
    ),
    Match.when(
      { op: "lte" },
      (c) => `parseFloat(${v}) <= parseFloat(${js(c.value)})`,
    ),
    Match.when(
      { op: "gte" },
      (c) => `parseFloat(${v}) >= parseFloat(${js(c.value)})`,
    ),
    Match.when(
      { op: "contains" },
      (c) => `String(${v}).indexOf(${js(c.value)}) !== -1`,
    ),
    Match.when(
      { op: "matches" },
      (c) => `new RegExp(${js(c.value)}).test(String(${v}))`,
    ),
    Match.when({ op: "isSet" }, () => `(${v} !== undefined && ${v} !== "")`),
    Match.when({ op: "notSet" }, () => `(${v} === undefined || ${v} === "")`),
    Match.exhaustive,
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

/**
 * Drop trailing `"undefined"` argument holes so an omitted optional Tasker
 * argument shortens the call instead of forwarding the literal identifier
 * `undefined` (whether the bridge coerces that to null or to the string
 * "undefined" cannot be checked from this repo — fewer arguments is the
 * documented default path). Only sound where every trailing hole came from
 * `opt()` on a simple optional value — not `sendIntent`'s trailing `extras`
 * array or `loadApp`'s trailing boolean, so use this only for `PerformTask`
 * and `PerformTaskerTask`.
 */
const trimTrailingUndefined = (args: ReadonlyArray<string>): Array<string> => {
  let end = args.length;
  while (end > 0 && args[end - 1] === "undefined") end--;
  return args.slice(0, end);
};

/**
 * `ShowScene`: resolve the device JS directory (same %TE_JS_DIR convention as
 * the dispatcher), read the synced layout JSON, substitute the directory
 * placeholder and hand the JSON to the generic `TE Show Scene` scaffolding
 * task as `%par1`.
 */
const emitShowScene = (a: ShowScene): Array<string> => [
  '__out = global("TE_JS_DIR");',
  `if (__out === undefined || __out === "") __out = ${js(DEFAULT_DEVICE_JS_DIR)};`,
  'if (__out.charAt(__out.length - 1) !== "/") __out = __out + "/";',
  `var __scene = readFile(__out + ${js(a.file)});`,
  'if (__scene === undefined || __scene === "") {',
  `  flash(${js(`tasker-effect: could not read scene ${a.file}`)});`,
  "} else {",
  `  performTask(${js(SHOW_SCENE_TASK_NAME)}, ${a.priority}, __scene.split(${js(SCENE_JS_DIR_PLACEHOLDER)}).join(__out));`,
  "}",
];

/** Compile one action to JavaScript source lines (unindented) */
export const emitAction = (action: Action): Array<string> =>
  // The chain is split across three .pipe calls because a single call cannot
  // type it: Pipeable's pipe() is overloaded for at most 21 functions, and
  // this match has 42 tags + Match.exhaustive. Merging them makes inference
  // collapse to `never` (verified: tsc rejects the merged chain).
  // @effect-diagnostics-next-line unnecessaryPipeChain:off
  Match.value(action)
    .pipe(
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
        `performTask(${trimTrailingUndefined([js(DISPATCH_TASK_NAME), String(a.priority), js(a.taskName), "undefined"]).join(", ")});`,
      ]),
      Match.tag("PerformTaskerTask", (a) => [
        `performTask(${trimTrailingUndefined([js(a.taskName), String(a.priority), opt(a.parameterOne), opt(a.parameterTwo)]).join(", ")});`,
      ]),
      Match.tag("ShowScene", emitShowScene),
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
          "})();",
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
      Match.tag("SetWifi", (a) => [`setWifi(${a.on});`]),
    )
    .pipe(
      Match.tag("SetBluetooth", (a) => [`setBT(${a.on});`]),
      Match.tag("SetAirplaneMode", (a) => [`setAirplaneMode(${a.on});`]),
      Match.tag("SetMobileData", (a) => [`mobileData(${a.on});`]),
      Match.tag("SetAutoSync", (a) => [`setAutoSync(${a.on});`]),
      Match.tag("SetVolume", (a) => [
        `${VOLUME_FN[a.stream]}(${typeof a.level === "number" ? a.level : emitText(a.level)}, ${a.display}, ${a.sound});`,
      ]),
      Match.tag("MediaControl", (a) => [`mediaControl(${js(a.action)});`]),
      Match.tag("MusicPlay", (a) => [
        `musicPlay(${emitText(a.path)}, ${a.offsetSecs}, ${a.loop}, ${js(a.stream)});`,
      ]),
      Match.tag("MusicStop", () => ["musicStop();"]),
      Match.tag("SetClip", (a) => [
        `setClip(${emitText(a.text)}, ${a.append});`,
      ]),
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
    )
    .pipe(
      Match.tag("SetCarMode", (a) => [`carMode(${a.on});`]),
      Match.tag("SetNightMode", (a) => [`nightMode(${a.on});`]),
      Match.tag("SetStayOn", (a) => [`stayOn(${js(a.mode)});`]),
      Match.tag("SetAutoRotate", (a) => [`displayAutoRotate(${a.on});`]),
      Match.tag("SetAutoBrightness", (a) => [`displayAutoBright(${a.on});`]),
      Match.tag("SetDisplayTimeout", (a) => [
        `displayTimeout(${a.hours}, ${a.minutes}, ${a.seconds});`,
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
      Match.exhaustive,
    );

// =============================================================================
// Task / Profile / Project compilation
// =============================================================================

const header = (title: string, description?: string): Array<string> => [
  "/**",
  ` * ${commentSafe(title)}`,
  ...(description !== undefined ? [` * ${commentSafe(description)}`] : []),
  " *",
  " * Generated by tasker-effect. Do not edit by hand.",
  " * Run in Tasker with a JavaScript action pointing at this file.",
  " */",
];

/** Compile a task to a standalone JavaScript source string */
export const compileTaskToJs = (task: Task): string => {
  const body = task.actions.flatMap((action) =>
    indentLines(emitAction(action), 4),
  );
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
      if (t.repeatMinutes !== undefined)
        parts.push(`every ${t.repeatMinutes}m`);
      if (t.days.length > 0) parts.push(`on ${t.days.join(", ")}`);
      return parts.join(" ");
    }),
    Match.tag(
      "LocationTrigger",
      (t) =>
        `Location within ${t.radiusMeters}m of ${t.latitude}, ${t.longitude}`,
    ),
    Match.tag(
      "WifiConnectedTrigger",
      (t) => `State > Net > Wifi Connected (SSID: ${t.ssid})`,
    ),
    Match.tag(
      "BluetoothConnectedTrigger",
      (t) => `State > Net > BT Connected (Name: ${t.name})`,
    ),
    Match.tag(
      "AppOpenedTrigger",
      (t) => `Application: ${t.invert ? "NOT " : ""}${t.app}`,
    ),
    Match.tag(
      "ClipboardChangedTrigger",
      (t) =>
        `Event > System > Clipboard Changed (Ignore Set By Tasker: ${t.ignoreSetByTasker ? "on" : "off"})`,
    ),
    Match.tag(
      "BatteryLevelTrigger",
      (t) => `State > Power > Battery Level from ${t.from}% to ${t.to}%`,
    ),
    Match.tag("HeadsetPluggedTrigger", (t) => {
      const kind =
        t.kind === "mic"
          ? "With Microphone"
          : t.kind === "no-mic"
            ? "Without Microphone"
            : "Any";
      return `State > Hardware > Headset Plugged (Type: ${kind})`;
    }),
    Match.tag(
      "PowerTrigger",
      (t) => `State > Power > Power (Source: ${t.source})`,
    ),
    Match.tag("CalendarEntryTrigger", (t) => {
      const filters = [
        ...(t.calendar !== undefined ? [`Calendar: ${t.calendar}`] : []),
        ...(t.title !== undefined ? [`Title: ${t.title}`] : []),
      ];
      return `State > App > Calendar Entry${filters.length > 0 ? ` (${filters.join(", ")})` : ""}`;
    }),
    Match.tag("ReceivedTextTrigger", (t) => {
      const kind = t.kind === "any" ? "Any" : t.kind.toUpperCase();
      const sender = t.sender !== undefined ? `, Sender: ${t.sender}` : "";
      return `Event > Phone > Received Text (Type: ${kind}${sender})`;
    }),
    Match.tag(
      "VariableTrigger",
      (t) =>
        `State > Variables > Variable Value: %${varNameOf(t.condition.variable)} ${t.condition.op}${"value" in t.condition ? ` ${t.condition.value}` : ""}`,
    ),
    Match.tag(
      "EventTrigger",
      (t) =>
        `Event: ${t.event}${t.parameter !== undefined ? ` (${t.parameter})` : ""}`,
    ),
    Match.tag(
      "StateTrigger",
      (t) =>
        `State: ${t.state}${t.parameter !== undefined ? ` (${t.parameter})` : ""}`,
    ),
    Match.exhaustive,
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
    ...(hasXmlWiring(profile)
      ? [
          `Wired in \`${TASKER_PROJECT_XML_FILENAME}\` (nothing to set up). Triggers:`,
        ]
      : ["Triggers to configure in the Tasker UI:"]),
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

/** Name of the sync task (download + unzip) created by the import XML */
export const SYNC_TASK_NAME = "TE Sync";

/** Name of the secrets-prompting task created by the import XML */
export const CONFIG_TASK_NAME = "TE Config";

/** Name of the generic Scenes v2 task created by the import XML */
export const SHOW_SCENE_TASK_NAME = "TE Show Scene";

/** Name of the periodic sync profile created by the import XML */
export const SYNC_PROFILE_NAME = "TE Sync";

/** Filename of the aggregated secrets manifest */
export const SECRETS_FILENAME = "secrets.json";

/** Filename of the synced `TE Config` scan logic (evaled by the XML stub) */
export const CONFIG_SCAN_FILENAME = "te-config-scan.js";

/** Filename of the synced `TE Config` label logic (evaled by the XML stub) */
export const CONFIG_LABEL_FILENAME = "te-config-label.js";

/**
 * Version of the static XML scaffolding. Bump it whenever
 * {@link taskerProjectXml} output changes in a way that requires re-importing
 * the project XML (v1 = the pre-stamp XML, which never set the global). The
 * imported `TE Sync` scriptlet stamps its version into the Tasker global
 * %TE_SCAFFOLD_VERSION on every sync; the synced dispatcher compares that
 * stamp against its own baked-in version and flashes a re-import warning
 * (without blocking dispatch) when the imported XML is older.
 */
export const SCAFFOLD_VERSION = 5;

/**
 * How to update the imported XML: Tasker refuses to import a project whose
 * name already exists, so the old one must be deleted first (globals, and
 * with them the secrets, survive the deletion).
 */
const REIMPORT_HINT = `delete the Tasker Effect project (Delete Contents) and re-import ${TASKER_PROJECT_XML_FILENAME} from the js dir`;

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
  const taskEntries = [
    ...project.tasks.map(
      (task) => `    ${js(task.name)}: ${js(`${slugify(task.name)}.js`)},`,
    ),
    `    ${js(MENU_TASK_NAME)}: ${js(MENU_SCRIPT_FILENAME)},`,
  ];
  const wiring = profileWiringHash(project.profiles);

  return [
    ...header(
      `Dispatcher: ${commentSafe(project.name)}`,
      "Single entry point that runs the mapped file for the calling profile or %par1.",
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
    "    // The imported XML stamps its scaffolding version on every sync; warn",
    "    // (but never block dispatch) when it is older than this build expects.",
    '    var installed = parseInt(global("TE_SCAFFOLD_VERSION"), 10);',
    "    if (!(installed > 0)) installed = 0;",
    `    if (installed < ${SCAFFOLD_VERSION}) {`,
    `      flash("tasker-effect: scaffolding v${SCAFFOLD_VERSION} required (installed: v" + installed + ") - ${REIMPORT_HINT}");`,
    "    }",
    "    // Same for the profile wiring: the imported XML stamps its hash into",
    "    // the TE_WIRING global; a mismatch means profile triggers changed since import.",
    `    if (global("TE_WIRING") !== ${js(wiring)}) {`,
    `      flash("tasker-effect: profile triggers changed - ${REIMPORT_HINT}");`,
    "    }",
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
    '      // The caller1 local is "profile=enter:<name>" / "profile=exit:<name>" when a',
    "      // profile state change launched this task.",
    '      var caller = local("caller1");',
    '      var match = /^profile=(enter|exit):([\\s\\S]+)$/.exec(caller === undefined ? "" : caller);',
    "      if (match === null) {",
    '        flash("tasker-effect dispatch: no %par1 given and caller is not a profile (caller1=" + caller + ")");',
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
// on commas), 360 Input Dialog (result lands in %input), 339 HTTP Request,
// 422 UnZip (condition op 8 = maths "=", as in a real export checking
// %http_response_code; an action-level condition is a <ConditionList sr="if">
// after the action's arguments). A Time context
// repeating every N hours is <rep>1</rep><repval>N</repval> with -1
// from/to fields.

/** Rolling GitHub release tag that CI keeps pointed at the newest build */
export const ROLLING_RELEASE_TAG = "tasker-js-latest";

/**
 * Filename of the bundled sync script (ProfileSync over the release assets).
 * The imported `TE Sync` task no longer runs it (it unzips
 * {@link RELEASE_ZIP_FILENAME} natively); it stays a reserved name and a
 * release asset for manual/legacy use.
 */
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

/** Rolling-release asset holding every synced file, flat at the zip root */
export const RELEASE_ZIP_FILENAME = "tasker-js.zip";

/**
 * Task local (set by `TE Sync`'s first action) holding the device path the
 * release zip is downloaded to. A full path rather than the directory alone:
 * Tasker would parse `%te_dirtasker` as one variable name.
 */
const SYNC_ZIP_LOCAL = "te_zip";

/** URL of the rolling release's {@link RELEASE_ZIP_FILENAME} asset */
export const releaseZipUrl = (repo: RepoRef): string =>
  `https://github.com/${repo.owner}/${repo.repo}/releases/download/${ROLLING_RELEASE_TAG}/${RELEASE_ZIP_FILENAME}`;

/**
 * First action of the `TE Sync` task: resolve the device JS dir, expose the
 * zip download path as the task local %te_zip for the native HTTP Request
 * and UnZip actions that follow, and stamp the imported XML's
 * {@link SCAFFOLD_VERSION} into %TE_SCAFFOLD_VERSION (and, when given, the
 * profile wiring hash into %TE_WIRING) so the synced dispatcher can detect
 * an outdated import.
 */
export const syncPrepareJs = (
  jsDir: string = DEFAULT_DEVICE_JS_DIR,
  wiringHash?: string,
): string =>
  [
    ...jsDirPreamble(jsDir),
    `setLocal(${js(SYNC_ZIP_LOCAL)}, dir + ${js(RELEASE_ZIP_FILENAME)});`,
    `setGlobal("TE_SCAFFOLD_VERSION", ${js(String(SCAFFOLD_VERSION))});`,
    ...(wiringHash === undefined
      ? []
      : [`setGlobal("TE_WIRING", ${js(wiringHash)});`]),
  ].join("\n");

/**
 * Last action of the `TE Sync` task: report the outcome of the download
 * (%http_response_code, set by the HTTP Request action) and queue
 * `TE Config` so newly declared secrets get prompted for after every sync.
 */
export const syncFinishJs: string = [
  'var code = local("http_response_code");',
  'if (code === "200") {',
  `  flash("tasker-effect: synced ${RELEASE_ZIP_FILENAME}");`,
  "} else {",
  `  flash("tasker-effect: downloading ${RELEASE_ZIP_FILENAME} failed (HTTP " + code + ")");`,
  "}",
  `performTask(${js(CONFIG_TASK_NAME)}, 5);`,
].join("\n");

/**
 * Header for the synced `TE Config` logic files: they are not standalone
 * scripts but are `eval`ed inside the matching XML stub's scriptlet, with the
 * stub's `dir` variable (resolved device JS directory) already in scope.
 */
const scaffoldHeader = (title: string): Array<string> => [
  "/**",
  ` * ${commentSafe(title)}`,
  " *",
  " * Generated by tasker-effect. Do not edit by hand.",
  " * Evaluated by the imported TE Config task's stub scriptlet; the stub's",
  " * `dir` variable (device JS directory) is in scope.",
  " */",
];

/**
 * Synced logic of `TE Config`'s first action (`te-config-scan.js`), two
 * modes:
 *
 * - **One-off** (`%par1` set, e.g. performed by the Tasker ConfigProvider):
 *   prompt for exactly that global when it is unset, using `%par2` as the
 *   dialog label when given.
 * - **Scan** (no `%par1`, after every sync): read secrets.json (waiting up
 *   to 30s for the first sync to deliver it — the scan file can arrive
 *   before secrets.json in the same sync) and collect the declared secrets
 *   whose Tasker global is unset or empty.
 *
 * Either way the names to prompt for land in the comma-separated local
 * %te_missing (left unset when nothing is missing, so the If guard skips
 * the prompt loop). The XML holds only a stub ({@link configScanStubJs})
 * that polls for this file and `eval`s it, so logic fixes ship via the
 * normal release sync without re-importing the XML.
 */
export const configScanFileJs: string = [
  ...scaffoldHeader("TE Config: scan for declared-but-unset secrets"),
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
  "",
].join("\n");

/**
 * Synced loop body of `TE Config` (`te-config-label.js`): resolve the
 * human-readable prompt label for the current secret (%te_secret) into
 * %te_prompt — an explicit %te_label (set by the one-off mode) wins, else
 * the secrets.json description, else the name itself. `eval`ed by the XML
 * stub ({@link configLabelStubJs}).
 */
export const configLabelFileJs: string = [
  ...scaffoldHeader("TE Config: resolve the prompt label for %te_secret"),
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
  "",
].join("\n");

/**
 * XML stub for `TE Config`'s first action: poll for the synced
 * {@link CONFIG_SCAN_FILENAME} and `eval` it. The poll (30 × 2s = 60s)
 * tolerates the first-run race — TE Sync queues TE Config *before* its
 * async downloads finish, so on a fresh import the file may not exist yet.
 */
const configScanStubJs = (jsDir: string): string =>
  [
    ...jsDirPreamble(jsDir),
    "var tries = 0;",
    "function boot() {",
    `  var src = readFile(dir + ${js(CONFIG_SCAN_FILENAME)});`,
    '  if ((src === undefined || src === "") && tries < 30) {',
    "    tries = tries + 1;",
    "    setTimeout(boot, 2000);",
    "    return;",
    "  }",
    '  if (src === undefined || src === "") {',
    `    flash("tasker-effect: ${CONFIG_SCAN_FILENAME} missing - run TE Sync");`,
    "    exit();",
    "    return;",
    "  }",
    "  eval(src);",
    "}",
    "boot();",
  ].join("\n");

/**
 * XML stub for `TE Config`'s label action: `eval` the synced
 * {@link CONFIG_LABEL_FILENAME}; when it is missing, degrade to the bare
 * %te_label/%te_secret so the prompt loop keeps working instead of breaking.
 */
const configLabelStubJs = (jsDir: string): string =>
  [
    ...jsDirPreamble(jsDir),
    `var src = readFile(dir + ${js(CONFIG_LABEL_FILENAME)});`,
    'if (src === undefined || src === "") {',
    '  var fallback = local("te_label");',
    '  if (fallback === undefined || fallback === "") fallback = local("te_secret");',
    '  setLocal("te_prompt", fallback);',
    "} else {",
    "  eval(src);",
    "}",
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
  body: ReadonlyArray<string>,
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
  options: { readonly autoExit: boolean; readonly timeoutSecs: number },
): Array<string> =>
  xmlAction(index, 129, [
    strArg(0, code),
    strArg(1, ""),
    intArg(2, options.autoExit ? 1 : 0),
    intArg(3, options.timeoutSecs),
  ]);

/**
 * Tasker collision handling (`<rty>`): absent/0 = Abort New Task,
 * 1 = Abort Existing Task, 2 = Run Both Together.
 */
const RUN_BOTH_TOGETHER = 2;

const xmlTask = (
  id: number,
  name: string,
  actions: ReadonlyArray<string>,
  options: { readonly collision?: number } = {},
): Array<string> => [
  `\t<Task sr="task${id}">`,
  "\t\t<cdate>1</cdate>",
  `\t\t<id>${id}</id>`,
  `\t\t<nme>${escapeXml(name)}</nme>`,
  ...(options.collision === undefined
    ? []
    : [`\t\t<rty>${options.collision}</rty>`]),
  ...actions,
  "\t</Task>",
];

const DISPATCH_TASK_ID = 1;
const SYNC_TASK_ID = 2;
const CONFIG_TASK_ID = 3;
const SYNC_PROFILE_ID = 4;
const SHOW_SCENE_TASK_ID = 5;
const MENU_TASK_ID = 6;

/** Perform Task action code */
const PERFORM_TASK_CODE = 130;

/**
 * Perform Task (130) running `TE Dispatch` with %par1 = `par1`. Argument
 * layout copied from test/fixtures/tasker-exports/show-clipboard-history.tsk.xml,
 * which imported fine on a device.
 */
const performDispatchAction = (index: number, par1: string): Array<string> =>
  xmlAction(index, PERFORM_TASK_CODE, [
    strArg(0, DISPATCH_TASK_NAME),
    intArg(1, 10),
    intArg(10, 0),
    strArg(2, par1),
    strArg(3, ""),
    strArg(4, ""),
    intArg(5, 0),
    intArg(6, 0),
    strArg(7, ""),
    intArg(8, 0),
    intArg(9, 0),
  ]);

/** Condition operators (`<op>`) used in the XML */
const CONDITION_MATHS_EQUALS = 8;
const CONDITION_IS_SET = 12;

/**
 * A single-condition `<ConditionList>`: the body of an If action (37), or,
 * appended after an action's arguments, that action's own condition.
 */
const conditionList = (lhs: string, op: number, rhs: string): Array<string> => [
  '\t\t\t<ConditionList sr="if">',
  '\t\t\t\t<Condition sr="c0" ve="3">',
  `\t\t\t\t\t<lhs>${escapeXml(lhs)}</lhs>`,
  `\t\t\t\t\t<op>${op}</op>`,
  `\t\t\t\t\t<rhs>${escapeXml(rhs)}</rhs>`,
  "\t\t\t\t</Condition>",
  "\t\t\t</ConditionList>",
];

/**
 * RELEVANT_VARIABLES bundle of the HTTP Request action, copied verbatim from
 * a real export (test/fixtures/tasker-exports/http-download-unzip.tsk.xml).
 */
const HTTP_REQUEST_RELEVANT_VARIABLES = [
  "&lt;StringArray sr=\"\"&gt;&lt;_array_net.dinglisch.android.tasker.RELEVANT_VARIABLES0&gt;%http_cookies",
  "Cookies",
  "The cookies the server sent in the response in the Cookie:COOKIE_VALUE format. You can use this directly in the 'Headers' field of the HTTP Request action&lt;/_array_net.dinglisch.android.tasker.RELEVANT_VARIABLES0&gt;&lt;_array_net.dinglisch.android.tasker.RELEVANT_VARIABLES1&gt;%http_file_output",
  "File Output",
  "Will always contain the file's full path even if you specified a directory as the File to save.&lt;/_array_net.dinglisch.android.tasker.RELEVANT_VARIABLES1&gt;&lt;_array_net.dinglisch.android.tasker.RELEVANT_VARIABLES2&gt;%http_response_code",
  "Response Code",
  "The HTTP Code the server responded&lt;/_array_net.dinglisch.android.tasker.RELEVANT_VARIABLES2&gt;&lt;_array_net.dinglisch.android.tasker.RELEVANT_VARIABLES3&gt;%http_headers()",
  "Response Headers",
  "The HTTP Headers the server sent in the response. Each header is in the 'key:value' format&lt;/_array_net.dinglisch.android.tasker.RELEVANT_VARIABLES3&gt;&lt;_array_net.dinglisch.android.tasker.RELEVANT_VARIABLES4&gt;%http_response_length",
  "Response Length",
  "The size of the response in bytes&lt;/_array_net.dinglisch.android.tasker.RELEVANT_VARIABLES4&gt;&lt;/StringArray&gt;",
].join("\n");

/**
 * HTTP Request (339): GET `url`, saving the response body to `filePath`,
 * following redirects (GitHub release downloads redirect to
 * objects.githubusercontent.com), 60s timeout. `<se>false</se>` (continue
 * task after error) lets the task report a failed download. Layout copied
 * from a real export, args in Tasker's lexical order.
 */
const httpDownloadAction = (
  index: number,
  url: string,
  filePath: string,
): Array<string> =>
  xmlAction(index, 339, [
    "\t\t\t<se>false</se>",
    '\t\t\t<Bundle sr="arg0">',
    '\t\t\t\t<Vals sr="val">',
    `\t\t\t\t\t<net.dinglisch.android.tasker.RELEVANT_VARIABLES>${HTTP_REQUEST_RELEVANT_VARIABLES}</net.dinglisch.android.tasker.RELEVANT_VARIABLES>`,
    "\t\t\t\t\t<net.dinglisch.android.tasker.RELEVANT_VARIABLES-type>[Ljava.lang.String;</net.dinglisch.android.tasker.RELEVANT_VARIABLES-type>",
    "\t\t\t\t</Vals>",
    "\t\t\t</Bundle>",
    intArg(1, 0), // method GET
    intArg(10, 1), // follow redirects
    intArg(11, 0), // use cookies
    intArg(12, 1), // structure output
    strArg(2, url),
    strArg(3, ""), // headers
    strArg(4, ""), // query parameters
    strArg(5, ""), // body
    strArg(6, ""), // file to send
    strArg(7, filePath), // file to save with output
    intArg(8, 60), // timeout (s)
    intArg(9, 0), // trust any certificate
  ]);

/**
 * UnZip (422) of `zipPath` into the zip's own directory, deleting the zip
 * afterwards, only when the preceding HTTP Request answered 200.
 */
const unzipAfterDownloadAction = (
  index: number,
  zipPath: string,
): Array<string> =>
  xmlAction(index, 422, [
    strArg(0, zipPath),
    intArg(1, 1), // delete zip
    ...conditionList("%http_response_code", CONDITION_MATHS_EQUALS, "200"),
  ]);

/** Names of the scaffold tasks in the project XML */
const SCAFFOLD_TASK_NAMES: ReadonlyArray<string> = [
  DISPATCH_TASK_NAME,
  SYNC_TASK_NAME,
  CONFIG_TASK_NAME,
  SHOW_SCENE_TASK_NAME,
  MENU_TASK_NAME,
];

/** Names that occur more than once */
const duplicatesOf = (names: ReadonlyArray<string>): Array<string> =>
  names.filter((name, index) => names.indexOf(name) !== index);

/**
 * Fail when two tasks or two profiles in the project XML share a name:
 * Tasker links profiles to tasks by name on import.
 */
const checkXmlNames = (
  taskNames: ReadonlyArray<string>,
  profileNames: ReadonlyArray<string>,
): void => {
  const problems = [
    ...duplicatesOf(taskNames).map(
      (name) => `task name "${name}" is used twice`,
    ),
    ...duplicatesOf(profileNames).map(
      (name) => `profile name "${name}" is used twice`,
    ),
  ];
  if (problems.length > 0) {
    throw new CompileError({
      message: `${TASKER_PROJECT_XML_FILENAME}: ${problems.join("; ")}`,
    });
  }
};

/** Options for the generated project XML */
export interface TaskerProjectXmlOptions {
  /** Repository whose rolling release TE Sync downloads from */
  readonly repo: RepoRef;
  /** Path of the dispatcher file on the device */
  readonly dispatcherPath?: string;
  /** Device directory holding the synced JS files */
  readonly jsDir?: string;
  /**
   * The project's profiles. Those whose triggers all have a known XML form
   * are wired in the XML; the others are left out (set up manually).
   */
  readonly profiles?: ReadonlyArray<Profile>;
}

/**
 * Importable Tasker **project** XML (`.prj.xml`) holding the complete static
 * scaffolding, so onboarding is: import once, enable, done.
 *
 * - Task `TE Dispatch`: file-based JavaScript action (131) running the
 *   dispatcher.
 * - Task `TE Sync`: a JavaScriptlet (129) resolving the JS dir and stamping
 *   the scaffolding version/wiring hash, HTTP Request (339) downloading the
 *   rolling release's tasker-js.zip into the JS dir, UnZip (422, only on
 *   HTTP 200) extracting it in place, and a JavaScriptlet reporting the
 *   outcome and queueing `TE Config`.
 * - Task `TE Config`: prompts (Input Dialog, 360) for every secret declared
 *   in secrets.json whose Tasker global is still unset. Its scan/label logic
 *   lives in the synced te-config-*.js files; the XML holds only stubs that
 *   `eval` them (polling on first run), so logic fixes never need a
 *   re-import.
 * - Task `TE Show Scene`: Show Scene v2 (479) with the layout JSON from
 *   `%par1`, used by the compiled `ShowScene` action — scenes themselves
 *   ship as synced JSON files, never in the XML.
 * - Task `TE Menu`: Perform Task → `TE Dispatch` with %par1 = "TE Menu",
 *   which lists the standalone tasks in a scene (bind it to a gesture or
 *   shortcut once).
 * - Profile `TE Sync`: Time context repeating every 6 hours, enter task
 *   `TE Sync`.
 * - Thin wiring for user profiles whose triggers have a known XML form:
 *   the triggers plus named enter/exit tasks (`TE <profile> (enter|exit)`)
 *   whose JavaScriptlet stamps the wiring hash into %TE_WIRING and
 *   evaluates the dispatcher.
 *
 * Besides that wiring, the XML is static scaffolding for a one-time import:
 * it never embeds compiled logic, standalone task names or secret names from
 * the user's project — only the pointer to the dispatcher and the embedded
 * repository slug.
 */
export const taskerProjectXml = (options: TaskerProjectXmlOptions): string => {
  const jsDir = options.jsDir ?? DEFAULT_DEVICE_JS_DIR;
  const dispatcherPath =
    options.dispatcherPath ?? `${jsDir}${DISPATCHER_FILENAME}`;
  const profiles = options.profiles ?? [];
  const user = userProfilesXml(profiles, jsDir);
  checkXmlNames(
    [...SCAFFOLD_TASK_NAMES, ...user.stubTasks.map((task) => task.name)],
    [SYNC_PROFILE_NAME, ...user.profileNames],
  );

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
    ...user.profiles,
    // Project element tying the pieces together.
    '\t<Project sr="proj0" ve="2">',
    "\t\t<cdate>1</cdate>",
    "\t\t<name>Tasker Effect</name>",
    `\t\t<pids>${[SYNC_PROFILE_ID, ...user.ids].join(",")}</pids>`,
    `\t\t<tids>${[DISPATCH_TASK_ID, SYNC_TASK_ID, CONFIG_TASK_ID, SHOW_SCENE_TASK_ID, MENU_TASK_ID, ...user.stubTasks.map((task) => task.id)].join(",")}</tids>`,
    "\t</Project>",
    // TE Dispatch: run the dispatcher file (Auto Exit on). The 600s action
    // timeout must exceed the config provider's default promptTimeoutMillis
    // (120s): prompt polling has to be able to outlive an open TE Config
    // dialog, otherwise Tasker kills the script before the provider can fail
    // over to Config.withDefault / Config.option. The value is deliberately
    // generous so timeout tuning ships in JS (promptTimeoutMillis), never in
    // the XML (which would force a re-import).
    ...xmlTask(DISPATCH_TASK_ID, DISPATCH_TASK_NAME, [
      ...xmlAction(0, 131, [
        strArg(0, dispatcherPath),
        strArg(1, ""),
        intArg(2, 1),
        intArg(3, 600),
      ]),
    ]),
    // TE Sync: download the release zip and unzip it natively into the JS
    // dir. The files never pass through a Tasker string, so no %variable
    // expansion can corrupt them (Tasker's JS writeFile() expands them).
    ...xmlTask(SYNC_TASK_ID, SYNC_TASK_NAME, [
      ...scriptletAction(
        0,
        syncPrepareJs(jsDir, profileWiringHash(profiles)),
        { autoExit: true, timeoutSecs: 45 },
      ),
      ...httpDownloadAction(
        1,
        releaseZipUrl(options.repo),
        `%${SYNC_ZIP_LOCAL}`,
      ),
      ...unzipAfterDownloadAction(2, `%${SYNC_ZIP_LOCAL}`),
      ...scriptletAction(3, syncFinishJs, { autoExit: true, timeoutSecs: 45 }),
    ]),
    // TE Config: prompt for declared-but-unset secrets. The scan/label logic
    // lives in synced te-config-*.js files; the XML holds only eval stubs.
    ...xmlTask(CONFIG_TASK_ID, CONFIG_TASK_NAME, [
      ...scriptletAction(0, configScanStubJs(jsDir), {
        autoExit: false,
        timeoutSecs: 600,
      }),
      ...xmlAction(1, 37, conditionList("%te_missing", CONDITION_IS_SET, "")),
      ...xmlAction(2, 39, [
        strArg(0, "%te_secret"),
        strArg(1, "%te_missing"),
        intArg(2, 0),
      ]),
      ...scriptletAction(3, configLabelStubJs(jsDir), {
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
    // TE Show Scene: Show Scene v2 (code 479) with the layout JSON passed in
    // %par1 by the compiled ShowScene action. Argument layout copied from a
    // real Tasker 6.7 export; every argument except Name/JSON (arg1) keeps
    // its default, so the layout's own defaultDisplayMode applies.
    ...xmlTask(SHOW_SCENE_TASK_ID, SHOW_SCENE_TASK_NAME, [
      ...xmlAction(0, 479, [
        '\t\t\t<Bundle sr="arg0">',
        '\t\t\t\t<Vals sr="val">',
        '\t\t\t\t\t<net.dinglisch.android.tasker.RELEVANT_VARIABLES>&lt;StringArray sr=""/&gt;</net.dinglisch.android.tasker.RELEVANT_VARIABLES>',
        "\t\t\t\t\t<net.dinglisch.android.tasker.RELEVANT_VARIABLES-type>[Ljava.lang.String;</net.dinglisch.android.tasker.RELEVANT_VARIABLES-type>",
        "\t\t\t\t</Vals>",
        "\t\t\t</Bundle>",
        strArg(1, "%par1"),
        strArg(10, ""),
        strArg(11, ""),
        intArg(12, 0),
        intArg(13, 0),
        intArg(14, 0),
        strArg(15, ""),
        intArg(16, 1),
        strArg(2, ""),
        strArg(3, ""),
        strArg(4, ""),
        strArg(5, ""),
        strArg(6, ""),
        strArg(7, ""),
        intArg(8, 1),
        strArg(9, ""),
      ]),
    ]),
    // TE Menu: run the dispatcher with %par1 = "TE Menu"; the synced
    // te-menu.js lists the standalone tasks and runs the tapped one.
    ...xmlTask(MENU_TASK_ID, MENU_TASK_NAME, [
      ...performDispatchAction(0, MENU_TASK_NAME),
    ]),
    ...user.tasks,
    "</TaskerData>",
    "",
  ].join("\n");
};

// =============================================================================
// User profile wiring inside the project XML
// =============================================================================

// Layouts copied from real Tasker 6.7.8 exports (see
// test/fixtures/tasker-exports/): Clipboard Changed is event code 2097 with
// "Ignore Set By Tasker" in Int arg1; an App context is inverted by
// <pin>true</pin> (Tasker writes <flags>2</flags> on every App context, so
// flags alone does not invert: verified on a device); Perform Task is action
// code 130.

/** Event code of Event > System > Clipboard Changed */
export const CLIPBOARD_CHANGED_EVENT_CODE = 2097;

/** Bundle with an empty RELEVANT_VARIABLES list (event/action arg0) */
const emptyRelevantVariables = (indent: string): Array<string> => [
  `${indent}<Bundle sr="arg0">`,
  `${indent}\t<Vals sr="val">`,
  `${indent}\t\t<net.dinglisch.android.tasker.RELEVANT_VARIABLES>&lt;StringArray sr=""/&gt;</net.dinglisch.android.tasker.RELEVANT_VARIABLES>`,
  `${indent}\t\t<net.dinglisch.android.tasker.RELEVANT_VARIABLES-type>[Ljava.lang.String;</net.dinglisch.android.tasker.RELEVANT_VARIABLES-type>`,
  `${indent}\t</Vals>`,
  `${indent}</Bundle>`,
];

/** A trigger's XML context, or undefined when it has no known XML form */
interface XmlContext {
  readonly isEvent: boolean;
  readonly lines: (sr: string) => Array<string>;
}

const clipboardChangedContext = (t: ClipboardChangedTrigger): XmlContext => ({
  isEvent: true,
  lines: (sr) => [
    `\t\t<Event sr="${sr}" ve="2">`,
    `\t\t\t<code>${CLIPBOARD_CHANGED_EVENT_CODE}</code>`,
    "\t\t\t<pri>0</pri>",
    ...emptyRelevantVariables("\t\t\t"),
    `\t\t\t<Int sr="arg1" val="${t.ignoreSetByTasker ? 1 : 0}"/>`,
    "\t\t</Event>",
  ],
});

const appContext = (t: AppOpenedTrigger, packageName: string): XmlContext => ({
  isEvent: false,
  lines: (sr) => [
    `\t\t<App sr="${sr}" ve="2">`,
    "\t\t\t<flags>2</flags>",
    `\t\t\t<label0>${escapeXml(t.app)}</label0>`,
    ...(t.invert ? ["\t\t\t<pin>true</pin>"] : []),
    `\t\t\t<pkg0>${escapeXml(packageName)}</pkg0>`,
    "\t\t</App>",
  ],
});

const xmlContextOf = (trigger: Trigger): XmlContext | undefined =>
  Match.value(trigger).pipe(
    Match.tag("ClipboardChangedTrigger", clipboardChangedContext),
    Match.tag("AppOpenedTrigger", (t) =>
      t.packageName === undefined ? undefined : appContext(t, t.packageName),
    ),
    Match.orElse(() => undefined),
  );

/**
 * Every trigger's XML context (event first, as Tasker expects), or undefined
 * when any trigger lacks a known XML form or there is more than one event.
 */
const xmlContextsOf = (
  profile: Profile,
): ReadonlyArray<XmlContext> | undefined => {
  const contexts = profile.triggers.map(xmlContextOf);
  if (contexts.some((context) => context === undefined)) return undefined;
  const known = contexts as ReadonlyArray<XmlContext>;
  const events = known.filter((context) => context.isEvent);
  if (events.length > 1) return undefined;
  return [...events, ...known.filter((context) => !context.isEvent)];
};

/** A profile that can be wired in the project XML, with its contexts */
interface XmlProfile {
  readonly profile: Profile;
  readonly contexts: ReadonlyArray<XmlContext>;
}

/** The profiles whose triggers all have a known XML form, in order */
const xmlProfilesOf = (profiles: ReadonlyArray<Profile>): Array<XmlProfile> =>
  profiles.flatMap((profile) => {
    const contexts = xmlContextsOf(profile);
    return contexts === undefined ? [] : [{ profile, contexts }];
  });

/** Whether a profile is wired in the project XML (no manual trigger setup) */
const hasXmlWiring = (profile: Profile): boolean =>
  xmlContextsOf(profile) !== undefined;

/** 32-bit FNV-1a hash as 8 hex digits */
const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/**
 * Short deterministic hash of the profile wiring in the project XML (names,
 * contexts, enter/exit presence). The imported XML stamps it into
 * %TE_WIRING and the synced dispatcher warns when it differs, i.e. when the
 * profile triggers changed and the XML must be re-imported.
 */
export const profileWiringHash = (profiles: ReadonlyArray<Profile>): string =>
  fnv1a(
    xmlProfilesOf(profiles)
      .map(({ profile, contexts }) =>
        [
          profile.name,
          profile.exit === undefined ? "enter" : "enter+exit",
          ...contexts.flatMap((context) => context.lines("con")),
        ].join("\n"),
      )
      .join("\n\n"),
  );

/** First id used for user profiles (scaffold ids stay below it) */
const USER_PROFILE_BASE_ID = 10;

/** Profile id, then enter/exit task ids, for the n-th XML profile */
const userProfileIds = (index: number) => {
  const id = USER_PROFILE_BASE_ID + index * 3;
  return { id, enter: id + 1, exit: id + 2 };
};

/**
 * Name of the generated task a wired profile runs on enter/exit. These must
 * be *named* tasks: Tasker drops anonymous tasks on project import (and the
 * profile could then link to an unrelated task with the same id), while
 * named tasks are remapped correctly even when their XML ids collide.
 */
export const profileTaskName = (
  profile: Profile,
  phase: "enter" | "exit",
): string => `TE ${profile.name} (${phase})`;

/** JavaScriptlet of the profile tasks */
const profileStubJs = (jsDir: string, wiringHash: string): string =>
  [
    ...jsDirPreamble(jsDir),
    `setGlobal("TE_WIRING", ${js(wiringHash)});`,
    `eval(readFile(dir + ${js(DISPATCHER_FILENAME)}));`,
  ].join("\n");

/** A generated profile task: id and name */
interface StubTask {
  readonly id: number;
  readonly name: string;
}

/** The user profiles' XML: <Profile> elements and their named stub tasks */
const userProfilesXml = (
  profiles: ReadonlyArray<Profile>,
  jsDir: string,
): {
  readonly ids: Array<number>;
  readonly profileNames: Array<string>;
  readonly stubTasks: Array<StubTask>;
  readonly profiles: Array<string>;
  readonly tasks: Array<string>;
} => {
  // The JavaScriptlet stamps the wiring hash and evaluates the dispatcher in
  // the profile's own task, so the event's locals (e.g. %cl_text) and
  // %caller1 stay visible to the compiled code.
  const stub = profileStubJs(jsDir, profileWiringHash(profiles));
  const wired = xmlProfilesOf(profiles).map(({ profile, contexts }, index) => {
    const ids = userProfileIds(index);
    const hasExit = profile.exit !== undefined;
    const stubTasks: Array<StubTask> = [
      { id: ids.enter, name: profileTaskName(profile, "enter") },
      ...(hasExit
        ? [{ id: ids.exit, name: profileTaskName(profile, "exit") }]
        : []),
    ];
    return {
      id: ids.id,
      name: profile.name,
      stubTasks,
      profile: [
        `\t<Profile sr="prof${ids.id}" ve="2">`,
        "\t\t<cdate>1</cdate>",
        `\t\t<id>${ids.id}</id>`,
        `\t\t<mid0>${ids.enter}</mid0>`,
        ...(hasExit ? [`\t\t<mid1>${ids.exit}</mid1>`] : []),
        `\t\t<nme>${escapeXml(profile.name)}</nme>`,
        ...contexts.flatMap((context, i) => context.lines(`con${i}`)),
        "\t</Profile>",
      ],
      tasks: stubTasks.flatMap((task) =>
        // Run Both Together: with the default (Abort New) a second trigger
        // while the task still runs is dropped, e.g. two quick copies.
        xmlTask(
          task.id,
          task.name,
          [...scriptletAction(0, stub, { autoExit: true, timeoutSecs: 600 })],
          { collision: RUN_BOTH_TOGETHER },
        ),
      ),
    };
  });
  return {
    ids: wired.map((entry) => entry.id),
    profileNames: wired.map((entry) => entry.name),
    stubTasks: wired.flatMap((entry) => entry.stubTasks),
    profiles: wired.flatMap((entry) => entry.profile),
    tasks: wired.flatMap((entry) => entry.tasks),
  };
};

const dispatcherReadmeSection = (project: Project): Array<string> => [
  "## One-time setup",
  "",
  `1. Import \`${TASKER_PROJECT_XML_FILENAME}\` once in Tasker (long-press the home`,
  "   icon at the bottom left → Import Project). This creates the shared task",
  `   \`${DISPATCH_TASK_NAME}\`, the \`${SYNC_TASK_NAME}\` task with its periodic`,
  `   profile, the \`${CONFIG_TASK_NAME}\` secrets prompter, the generic \`${SHOW_SCENE_TASK_NAME}\``,
  `   task used by \`Action.showScene\`, the \`${MENU_TASK_NAME}\` task and every profile`,
  "   below whose triggers have a known XML form. Enable the `" +
    SYNC_PROFILE_NAME +
    "`",
  "   profile (or run the task once) and it downloads everything else by",
  "   itself — no files need to be copied manually.",
  '2. For each profile below marked "Triggers to configure", set up its',
  `   trigger(s) in the Tasker UI with \`${DISPATCH_TASK_NAME}\` as enter and exit task. The`,
  "   dispatcher detects the calling profile from `%caller1`",
  "   (`profile=enter:<name>` / `profile=exit:<name>`) and runs the matching file.",
  ...(project.tasks.length > 0
    ? [
        `3. Bind \`${MENU_TASK_NAME}\` to a gesture or shortcut: it lists the standalone`,
        `   tasks and runs the one you tap. Or Perform Task → \`${DISPATCH_TASK_NAME}\` with`,
        "   the task name as `%par1` (`%par2` = `exit` forces a profile's exit file).",
      ]
    : []),
  "",
  "The dispatcher reads files from `" +
    DEFAULT_DEVICE_JS_DIR +
    "`; override with",
  "the Tasker global `%TE_JS_DIR` (then also edit the path in the imported",
  "task).",
  "",
  `Sync also keeps the current \`${TASKER_PROJECT_XML_FILENAME}\` in that directory.`,
  "Re-import it from there when the dispatcher flashes a warning (scaffolding",
  "outdated or profile triggers changed). Tasker refuses to import a project",
  "whose name exists, so first delete the Tasker Effect project (choose",
  "Delete Contents); global variables, including secrets, survive.",
  "",
];

// =============================================================================
// Secrets manifest
// =============================================================================

/**
 * Recursively find every {@link Secret} referenced inside a value: whole
 * field values, interpolation parts, condition variables, header records,
 * extras arrays and nested `If` branches are all reached by walking the
 * plain data of the action tree.
 */
const walkSecrets = (
  node: unknown,
  visit: (secret: Secret) => void,
  seen: Set<object>,
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
 * Collect every secret *used* anywhere in the project (profiles' enter/exit
 * tasks, standalone tasks, and trigger conditions), deduplicated by name.
 * Secrets are detected at their use sites — a declared but unused secret is
 * not emitted. The same name with two different descriptions is a conflict
 * and fails compilation.
 */
export const collectProjectSecrets = (project: Project): Array<Secret> => {
  const byName = new Map<string, Secret>();
  const addFrom = (owner: string, node: unknown): void => {
    walkSecrets(
      node,
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
      new Set(),
    );
  };
  for (const profile of project.profiles) {
    addFrom(`profile "${profile.name}" triggers`, profile.triggers);
    addFrom(`profile "${profile.name}" enter task`, profile.enter.actions);
    if (profile.exit !== undefined) {
      addFrom(`profile "${profile.name}" exit task`, profile.exit.actions);
    }
  }
  for (const task of project.tasks) {
    addFrom(`task "${task.name}"`, task.actions);
  }
  // Arr.sort accepts any Iterable, so the Map's value iterator needs no
  // array-copy first — it isn't a defensive copy either: Arr.sort never
  // mutates its input.
  return Arr.sort(
    byName.values(),
    Order.mapInput(Order.string, (s: Secret) => s.name),
  );
};

/**
 * The wire shape of `secrets.json`: a named, exported contract a test or
 * third-party generator can decode against. Renaming a `Secret` field
 * already fails typecheck here, and the two device-side consumers are
 * emitted ES5 that cannot use a Schema either way — this buys a documented
 * contract, not drift protection.
 */
export const SecretManifest = Schema.Array(
  Schema.Struct({ name: Schema.String, description: Schema.String }),
);

/**
 * The secrets manifest shipped with the release assets and synced to the
 * device. `TE Config` reads it after every sync and prompts only for entries
 * whose Tasker global is still unset. Always emitted (even when empty) so
 * the on-device state can converge after secrets are removed.
 */
export const compileSecretsJson = (project: Project): string =>
  `${JSON.stringify(
    Schema.encodeSync(SecretManifest)(collectProjectSecrets(project)),
    null,
    2,
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
 * `project.tasks` — those are the only names the dispatcher's task map
 * knows — if a task name duplicates another task or profile name, or if a
 * name is reused within `project.tasks` or within `project.profiles` (the
 * dispatcher's map literals silently keep only the last key). Every problem
 * found is reported together in one `CompileError`, rather than stopping at
 * the first. Only Project compilation can run this check: a standalone task
 * or profile has no surrounding project to resolve references against.
 */
const checkTaskReferences = (project: Project): void => {
  const targets = project.tasks.map((task) => task.name);
  const targetList =
    targets.length > 0
      ? targets.map((name) => `"${name}"`).join(", ")
      : "(none)";
  const problems: Array<string> = [];

  const findDuplicates = (
    label: string,
    names: ReadonlyArray<string>,
  ): void => {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) problems.push(`Duplicate ${label} name "${name}"`);
      seen.add(name);
    }
  };
  findDuplicates("task", targets);
  findDuplicates(
    "profile",
    project.profiles.map((profile) => profile.name),
  );

  // The dispatcher resolves PROFILES before TASKS (compileDispatcherJs), so
  // a name shared between both is ambiguous: performTask(name) would
  // silently run the profile's enter file instead of the standalone task.
  const profileNames = new Set(project.profiles.map((profile) => profile.name));
  for (const task of project.tasks) {
    if (profileNames.has(task.name)) {
      problems.push(
        `"${task.name}" is both a profile and a task; the dispatcher resolves %par1 against profiles first`,
      );
    }
  }

  const check = (owner: string, task: Task): void => {
    for (const ref of collectTaskRefs(task.actions)) {
      if (!targets.includes(ref)) {
        problems.push(`${owner} references unknown task "${ref}"`);
      }
    }
  };
  for (const profile of project.profiles) {
    check(
      `Profile "${profile.name}" enter task "${profile.enter.name}"`,
      profile.enter,
    );
    if (profile.exit !== undefined) {
      check(
        `Profile "${profile.name}" exit task "${profile.exit.name}"`,
        profile.exit,
      );
    }
  }
  for (const task of project.tasks) {
    check(`Task "${task.name}"`, task);
  }

  if (problems.length > 0) {
    throw new CompileError({
      message: `${problems.join("; ")}. Valid targets: ${targetList}`,
      source: project.name,
    });
  }
};

/** Reserved scaffold filenames a task/profile's slugified name must not collide with */
const RESERVED_FILENAMES: ReadonlySet<string> = new Set([
  DISPATCHER_FILENAME,
  CONFIG_SCAN_FILENAME,
  CONFIG_LABEL_FILENAME,
  SECRETS_FILENAME,
  TASKER_PROJECT_XML_FILENAME,
  SYNC_SCRIPT_FILENAME,
  MENU_SCRIPT_FILENAME,
  MENU_SCENE_FILENAME,
  MENU_HTML_FILENAME,
  "README.md",
]);

/**
 * Fail compilation if two definitions would slugify to the same emitted
 * filename, or if one slugifies to a reserved scaffold filename — either
 * way, one `CompiledFile` would silently overwrite another's (or the
 * scaffold's) content, with the dispatcher then routing both source names to
 * just one file. Every collision is reported together in one `CompileError`.
 */
const checkFilenames = (project: Project): void => {
  const claimed = new Map<string, string>();
  const problems: Array<string> = [];
  const claim = (filename: string, owner: string): void => {
    if (RESERVED_FILENAMES.has(filename)) {
      problems.push(
        `${owner} slugifies to the reserved filename "${filename}"`,
      );
      return;
    }
    const existing = claimed.get(filename);
    if (existing !== undefined) {
      problems.push(
        `${owner} and ${existing} both slugify to filename "${filename}"`,
      );
      return;
    }
    claimed.set(filename, owner);
  };
  for (const profile of project.profiles) {
    const slug = slugify(profile.name);
    claim(`${slug}.enter.js`, `Profile "${profile.name}" (enter)`);
    if (profile.exit !== undefined) {
      claim(`${slug}.exit.js`, `Profile "${profile.name}" (exit)`);
    }
  }
  for (const task of project.tasks) {
    claim(`${slugify(task.name)}.js`, `Task "${task.name}"`);
  }
  if (problems.length > 0) {
    throw new CompileError({
      message: problems.join("; "),
      source: project.name,
    });
  }
};

/** Compile a whole project to JS files plus a setup README */
export const compileProjectFiles = (
  project: Project,
  options: CompileProjectOptions,
): Array<CompiledFile> => {
  checkTaskReferences(project);
  checkFilenames(project);
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
    filename: CONFIG_SCAN_FILENAME,
    content: configScanFileJs,
    kind: "scaffold-js",
  });
  files.push({
    filename: CONFIG_LABEL_FILENAME,
    content: configLabelFileJs,
    kind: "scaffold-js",
  });
  files.push(
    {
      filename: MENU_SCRIPT_FILENAME,
      content: menuScriptJs(SHOW_SCENE_TASK_NAME, SCENE_JS_DIR_PLACEHOLDER),
      kind: "scaffold-js",
    },
    {
      filename: MENU_SCENE_FILENAME,
      content: menuSceneJson(SCENE_JS_DIR_PLACEHOLDER),
      kind: "web-asset",
    },
    { filename: MENU_HTML_FILENAME, content: menuHtml, kind: "web-asset" },
  );
  files.push({
    filename: SECRETS_FILENAME,
    content: compileSecretsJson(project),
    kind: "secrets-json",
  });
  files.push({
    filename: TASKER_PROJECT_XML_FILENAME,
    content: taskerProjectXml({
      repo: options.repo,
      profiles: project.profiles,
    }),
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
              `- ${task.name}: \`${slugify(task.name)}.js\`${task.description !== undefined ? ` — ${task.description}` : ""}`,
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

/**
 * Run a throwing pure function as an Effect, converting a genuine
 * `CompileError` into a typed failure but letting anything else — in
 * particular a `Match.exhaustive` defect from an internal bug the compiler's
 * own linker cannot catch — re-throw and stay a defect. Effect.try's
 * `catch` normally *must* return an `E`; throwing from inside it here is
 * deliberate: the exception propagates out of the surrounding
 * `Effect.suspend` the same way an `Effect.sync` thunk's throw would, so the
 * fiber runtime records it as `Cause.die`, not a laundered typed error. This
 * is the only place a throwing pure compiler function is wrapped —
 * `compileTaskToJs`/`compileProfileFiles` are actually total (no `throw`
 * site of their own) and are run with plain `Effect.sync` below.
 */
const tryCompile = <A>(run: () => A): Effect.Effect<A, CompileError> =>
  Effect.try({
    try: run,
    catch: (cause) => {
      if (cause instanceof CompileError) return cause;
      throw cause;
    },
  });

/**
 * Effect service around the pure compiler functions, for use in build
 * pipelines composed with other services.
 */
export class TaskerCompiler extends Effect.Service<TaskerCompiler>()(
  "TaskerCompiler",
  {
    sync: () => ({
      compileTask: (task: Task): Effect.Effect<CompiledFile> =>
        Effect.sync(() => ({
          filename: `${slugify(task.name)}.js`,
          content: compileTaskToJs(task),
          kind: "task-js" as const,
        })),
      compileProfile: (profile: Profile): Effect.Effect<Array<CompiledFile>> =>
        Effect.sync(() => compileProfileFiles(profile)),
      compileProject: (
        project: Project,
        options: CompileProjectOptions,
      ): Effect.Effect<Array<CompiledFile>, CompileError> =>
        tryCompile(() => compileProjectFiles(project, options)),
    }),
  },
) {}
