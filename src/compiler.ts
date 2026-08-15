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
  readonly kind: "task-js" | "doc";
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

  const readme = [
    `# ${project.name}`,
    "",
    ...(project.description !== undefined ? [project.description, ""] : []),
    "Compiled with tasker-effect. Copy the `.js` files to your device (e.g.",
    "`/sdcard/Tasker/js/`) and point Tasker JavaScript actions at them.",
    "",
    "## Files",
    "",
    ...files.map((file) => `- \`${file.filename}\``),
    "",
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
