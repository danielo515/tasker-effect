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
  type Trigger,
  type VolumeStream,
  Condition,
  Profile,
  Project,
  Task,
  isGlobalVariable,
  variableName,
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
  readonly kind: "task-js" | "dispatcher-js" | "tasker-xml" | "doc";
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

/** Compile a Condition to a JavaScript boolean expression */
export const conditionExpr = (condition: Condition): string => {
  const v = readVarExpr(condition.variable);
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

const opt = (value: string | undefined): string =>
  value === undefined ? "undefined" : js(value);

/** Compile one action to JavaScript source lines (unindented) */
export const emitAction = (action: Action): Array<string> =>
  Match.value(action).pipe(
    Match.tag("Flash", (a) => [
      `${a.long ? "flashLong" : "flash"}(${js(a.text)});`,
    ]),
    Match.tag("Popup", (a) => [
      `popup(${js(a.title)}, ${js(a.text)}, ${a.showOverKeyguard}, "", "", ${a.timeoutSecs});`,
    ]),
    Match.tag("Say", (a) => [
      `say(${js(a.text)}, ${opt(a.engine)}, ${opt(a.voice)}, ${js(a.stream)}, ${a.pitch}, ${a.speed});`,
    ]),
    Match.tag("Vibrate", (a) => [`vibrate(${a.milliseconds});`]),
    Match.tag("VibratePattern", (a) => [`vibratePattern(${js(a.pattern)});`]),
    Match.tag("SetGlobal", (a) => [`setGlobal(${js(a.name)}, ${js(a.value)});`]),
    Match.tag("SetLocal", (a) => [`setLocal(${js(a.name)}, ${js(a.value)});`]),
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
      const call = `shell(${js(a.command)}, ${a.asRoot}, ${a.timeoutSecs})`;
      if (a.outputGlobal === undefined) {
        return [`${call};`];
      }
      return [
        `__out = ${call};`,
        `setGlobal(${js(a.outputGlobal)}, __out === undefined ? "" : String(__out));`,
      ];
    }),
    Match.tag("ReadFile", (a) => [
      `__out = readFile(${js(a.path)});`,
      `setGlobal(${js(a.outputGlobal)}, __out === undefined ? "" : String(__out));`,
    ]),
    Match.tag("WriteFile", (a) => [
      `writeFile(${js(a.path)}, ${js(a.text)}, ${a.append});`,
    ]),
    Match.tag("HttpRequest", (a) => {
      const lines = [
        "__out = (function () {",
        "  var xhr = new XMLHttpRequest();",
        `  xhr.open(${js(a.method)}, ${js(a.url)}, false);`,
      ];
      for (const [key, value] of Object.entries(a.headers)) {
        lines.push(`  xhr.setRequestHeader(${js(key)}, ${js(value)});`);
      }
      lines.push(
        `  xhr.send(${a.body === undefined ? "null" : js(a.body)});`,
        "  return xhr.responseText;",
        "})();"
      );
      if (a.outputGlobal !== undefined) {
        lines.push(`setGlobal(${js(a.outputGlobal)}, __out);`);
      }
      return lines;
    }),
    Match.tag("BrowseUrl", (a) => [`browseURL(${js(a.url)});`]),
    Match.tag("SendSms", (a) => [
      `sendSMS(${js(a.number)}, ${js(a.text)}, ${a.storeInMessagingApp});`,
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
      `musicPlay(${js(a.path)}, ${a.offsetSecs}, ${a.loop}, ${js(a.stream)});`,
    ]),
    Match.tag("MusicStop", () => ["musicStop();"]),
    Match.tag("SetClip", (a) => [`setClip(${js(a.text)}, ${a.append});`]),
    Match.tag("SetWallpaper", (a) => [`setWallpaper(${js(a.path)});`]),
    Match.tag("LaunchApp", (a) => [
      `loadApp(${js(a.app)}, ${opt(a.data)}, ${a.excludeFromRecents});`,
    ]),
    Match.tag("SendIntent", (a) => {
      const extras = `[${a.extras.map((extra) => js(extra)).join(", ")}]`;
      return [
        `sendIntent(${js(a.action)}, ${js(a.targetComp)}, ${opt(a.pkg)}, ${opt(a.cls)}, ${opt(a.category)}, ${opt(a.data)}, ${opt(a.mimeType)}, ${extras});`,
      ];
    }),
    Match.tag("SetSilentMode", (a) => [`silentMode(${js(a.mode)});`]),
    Match.tag("GoHome", (a) => [`goHome(${a.screen});`]),
    Match.tag("GetLocation", (a) => [
      `getLocation(${js(a.source)}, ${a.keepTracking}, ${a.timeoutSecs});`,
    ]),
    Match.tag("JavaScript", (a) => a.code.split("\n")),
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

/** Filename of the importable Tasker task XML */
export const TASKER_IMPORT_XML_FILENAME = "tasker-effect.tsk.xml";

/** Name of the shared Tasker task created by the import XML */
export const DISPATCH_TASK_NAME = "TE Dispatch";

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

/**
 * Importable Tasker task XML containing the shared "TE Dispatch" task, whose
 * only action is a file-based JavaScript action (Tasker action code 131,
 * verified against real .tsk.xml exports and the Taskomater Tasker-XML-Info
 * action code list; the JavaScriptlet action is 129) pointing at the
 * dispatcher. Argument layout of action 131: arg0 = script path (Str),
 * arg1 = libraries (Str), arg2 = Auto Exit (Int, on), arg3 = timeout in
 * seconds (Int).
 *
 * This XML is static scaffolding for a one-time import: it never embeds
 * compiled logic, only the pointer to the dispatcher file.
 */
export const taskerImportXml = (options?: {
  readonly dispatcherPath?: string;
}): string => {
  const path =
    options?.dispatcherPath ?? `${DEFAULT_DEVICE_JS_DIR}${DISPATCHER_FILENAME}`;
  return [
    '<TaskerData sr="" dvi="1" tv="6.3.13">',
    '\t<Task sr="task1">',
    "\t\t<cdate>1</cdate>",
    "\t\t<id>1</id>",
    `\t\t<nme>${escapeXml(DISPATCH_TASK_NAME)}</nme>`,
    '\t\t<Action sr="act0" ve="7">',
    "\t\t\t<code>131</code>",
    `\t\t\t<Str sr="arg0" ve="3">${escapeXml(path)}</Str>`,
    '\t\t\t<Str sr="arg1" ve="3"/>',
    '\t\t\t<Int sr="arg2" val="1"/>',
    '\t\t\t<Int sr="arg3" val="45"/>',
    "\t\t</Action>",
    "\t</Task>",
    "</TaskerData>",
    "",
  ].join("\n");
};

const dispatcherReadmeSection = (project: Project): Array<string> => [
  "## One-time setup with the dispatcher",
  "",
  `1. Import \`${TASKER_IMPORT_XML_FILENAME}\` once in Tasker (long-press the`,
  `   Tasks tab → Import Task). This creates the shared task \`${DISPATCH_TASK_NAME}\`,`,
  `   whose only action runs \`${DEFAULT_DEVICE_JS_DIR}${DISPATCHER_FILENAME}\`.`,
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
export const compileProjectFiles = (project: Project): Array<CompiledFile> => {
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
    filename: TASKER_IMPORT_XML_FILENAME,
    content: taskerImportXml(),
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
        project: Project
      ): Effect.Effect<Array<CompiledFile>, CompileError> =>
        tryCompile(() => compileProjectFiles(project), project.name),
    }),
  }
) {}
