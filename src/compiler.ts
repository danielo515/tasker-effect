/**
 * @module compiler
 * @description Compiles profile/task definitions to plain JavaScript that
 * Tasker executes directly via its JavaScript / JavaScriptlet actions.
 *
 * The emitted code only uses Tasker's documented global functions plus
 * XMLHttpRequest (available in Tasker's WebView-based JS environment), so it
 * needs no bundler and no runtime dependencies.
 */

import { Effect, Schema } from "effect";
import {
  type Action,
  type Trigger,
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
  switch (condition.op) {
    case "eq":
      return `${v} === ${js(value)}`;
    case "neq":
      return `${v} !== ${js(value)}`;
    case "lt":
      return `parseFloat(${v}) < parseFloat(${js(value)})`;
    case "gt":
      return `parseFloat(${v}) > parseFloat(${js(value)})`;
    case "lte":
      return `parseFloat(${v}) <= parseFloat(${js(value)})`;
    case "gte":
      return `parseFloat(${v}) >= parseFloat(${js(value)})`;
    case "contains":
      return `String(${v}).indexOf(${js(value)}) !== -1`;
    case "matches":
      return `new RegExp(${js(value)}).test(String(${v}))`;
    case "isSet":
      return `(${v} !== undefined && ${v} !== "")`;
    case "notSet":
      return `(${v} === undefined || ${v} === "")`;
  }
};

const VOLUME_FN: Record<string, string> = {
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
export const emitAction = (action: Action): Array<string> => {
  switch (action._tag) {
    case "Flash":
      return [`${action.long ? "flashLong" : "flash"}(${js(action.text)});`];
    case "Popup":
      return [
        `popup(${js(action.title)}, ${js(action.text)}, ${action.showOverKeyguard}, "", "", ${action.timeoutSecs});`,
      ];
    case "Say":
      return [
        `say(${js(action.text)}, ${opt(action.engine)}, ${opt(action.voice)}, ${js(action.stream)}, ${action.pitch}, ${action.speed});`,
      ];
    case "Vibrate":
      return [`vibrate(${action.milliseconds});`];
    case "VibratePattern":
      return [`vibratePattern(${js(action.pattern)});`];
    case "SetGlobal":
      return [`setGlobal(${js(action.name)}, ${js(action.value)});`];
    case "SetLocal":
      return [`setLocal(${js(action.name)}, ${js(action.value)});`];
    case "PerformTask":
      return [
        `performTask(${js(action.taskName)}, ${action.priority}, ${opt(action.parameterOne)}, ${opt(action.parameterTwo)});`,
      ];
    case "EnableProfile":
      return [`enableProfile(${js(action.profileName)}, ${action.enable});`];
    case "Wait":
      return [`wait(${action.milliseconds});`];
    case "Shell": {
      const call = `shell(${js(action.command)}, ${action.asRoot}, ${action.timeoutSecs})`;
      if (action.outputGlobal === undefined) {
        return [`${call};`];
      }
      return [
        `__out = ${call};`,
        `setGlobal(${js(action.outputGlobal)}, __out === undefined ? "" : String(__out));`,
      ];
    }
    case "ReadFile":
      return [
        `__out = readFile(${js(action.path)});`,
        `setGlobal(${js(action.outputGlobal)}, __out === undefined ? "" : String(__out));`,
      ];
    case "WriteFile":
      return [
        `writeFile(${js(action.path)}, ${js(action.text)}, ${action.append});`,
      ];
    case "HttpRequest": {
      const lines = [
        "__out = (function () {",
        "  var xhr = new XMLHttpRequest();",
        `  xhr.open(${js(action.method)}, ${js(action.url)}, false);`,
      ];
      for (const [key, value] of Object.entries(action.headers)) {
        lines.push(`  xhr.setRequestHeader(${js(key)}, ${js(value)});`);
      }
      lines.push(
        `  xhr.send(${action.body === undefined ? "null" : js(action.body)});`,
        "  return xhr.responseText;",
        "})();"
      );
      if (action.outputGlobal !== undefined) {
        lines.push(`setGlobal(${js(action.outputGlobal)}, __out);`);
      }
      return lines;
    }
    case "BrowseUrl":
      return [`browseURL(${js(action.url)});`];
    case "SendSms":
      return [
        `sendSMS(${js(action.number)}, ${js(action.text)}, ${action.storeInMessagingApp});`,
      ];
    case "SetWifi":
      return [`setWifi(${action.on});`];
    case "SetBluetooth":
      return [`setBT(${action.on});`];
    case "SetAirplaneMode":
      return [`setAirplaneMode(${action.on});`];
    case "SetMobileData":
      return [`mobileData(${action.on});`];
    case "SetAutoSync":
      return [`setAutoSync(${action.on});`];
    case "SetVolume": {
      const fn = VOLUME_FN[action.stream];
      if (fn === undefined) {
        throw new CompileError({
          message: `Unknown volume stream: ${action.stream}`,
        });
      }
      return [`${fn}(${action.level}, ${action.display}, ${action.sound});`];
    }
    case "MediaControl":
      return [`mediaControl(${js(action.action)});`];
    case "MusicPlay":
      return [
        `musicPlay(${js(action.path)}, ${action.offsetSecs}, ${action.loop}, ${js(action.stream)});`,
      ];
    case "MusicStop":
      return ["musicStop();"];
    case "SetClip":
      return [`setClip(${js(action.text)}, ${action.append});`];
    case "SetWallpaper":
      return [`setWallpaper(${js(action.path)});`];
    case "LaunchApp":
      return [
        `loadApp(${js(action.app)}, ${opt(action.data)}, ${action.excludeFromRecents});`,
      ];
    case "SendIntent": {
      const extras = `[${action.extras.map((extra) => js(extra)).join(", ")}]`;
      return [
        `sendIntent(${js(action.action)}, ${js(action.targetComp)}, ${opt(action.pkg)}, ${opt(action.cls)}, ${opt(action.category)}, ${opt(action.data)}, ${opt(action.mimeType)}, ${extras});`,
      ];
    }
    case "SetSilentMode":
      return [`silentMode(${js(action.mode)});`];
    case "GoHome":
      return [`goHome(${action.screen});`];
    case "GetLocation":
      return [
        `getLocation(${js(action.source)}, ${action.keepTracking}, ${action.timeoutSecs});`,
      ];
    case "JavaScript":
      return action.code.split("\n");
    case "If": {
      const lines = [`if (${conditionExpr(action.condition)}) {`];
      for (const inner of action.then) {
        lines.push(...indentLines(emitAction(inner), 2));
      }
      if (action.orElse.length > 0) {
        lines.push("} else {");
        for (const inner of action.orElse) {
          lines.push(...indentLines(emitAction(inner), 2));
        }
      }
      lines.push("}");
      return lines;
    }
  }
};

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
export const describeTrigger = (trigger: Trigger): string => {
  switch (trigger._tag) {
    case "TimeTrigger": {
      const fmt = (t: { hour: number; minute: number }) =>
        `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
      const parts = [`Time from ${fmt(trigger.from)}`];
      if (trigger.to !== undefined) parts.push(`to ${fmt(trigger.to)}`);
      if (trigger.repeatMinutes !== undefined)
        parts.push(`every ${trigger.repeatMinutes}m`);
      if (trigger.days.length > 0) parts.push(`on ${trigger.days.join(", ")}`);
      return parts.join(" ");
    }
    case "LocationTrigger":
      return `Location within ${trigger.radiusMeters}m of ${trigger.latitude}, ${trigger.longitude}`;
    case "WifiConnectedTrigger":
      return `State > Net > Wifi Connected (SSID: ${trigger.ssid})`;
    case "BluetoothConnectedTrigger":
      return `State > Net > BT Connected (Name: ${trigger.name})`;
    case "AppOpenedTrigger":
      return `Application: ${trigger.app}`;
    case "BatteryLevelTrigger":
      return `State > Power > Battery Level from ${trigger.from}% to ${trigger.to}%`;
    case "VariableTrigger":
      return `State > Variables > Variable Value: %${trigger.condition.variable} ${trigger.condition.op} ${trigger.condition.value ?? ""}`;
    case "EventTrigger":
      return `Event: ${trigger.event}${trigger.parameter !== undefined ? ` (${trigger.parameter})` : ""}`;
    case "StateTrigger":
      return `State: ${trigger.state}${trigger.parameter !== undefined ? ` (${trigger.parameter})` : ""}`;
  }
};

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

/** Compile a whole project to JS files plus a setup README */
export const compileProjectFiles = (project: Project): Array<CompiledFile> => {
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
