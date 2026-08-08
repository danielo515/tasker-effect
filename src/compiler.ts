/**
 * @module compiler
 * @description Compiles TypeScript profiles to Tasker-importable XML format
 */

import { Effect, Context, Layer, Data } from "effect";
import type {
  Profile,
  Task,
  Project,
  Action,
  Trigger,
  TimeSpec,
} from "./profile.js";

// =============================================================================
// Types
// =============================================================================

const TASKER_VERSION = "5.9.rc";
const DVI = "1";
const VE_PROFILE = "2";
const VE_TASK = "7";

/** Compilation error */
export class CompilerError extends Data.TaggedError("CompilerError")<{
  readonly message: string;
  readonly source?: string;
}> {}

/** Compiled output */
export interface CompiledOutput {
  readonly filename: string;
  readonly content: string;
  readonly type: "task" | "profile" | "project";
}

// =============================================================================
// ID Generator
// =============================================================================

class IdGenerator {
  private taskId = 0;
  private profileId = 0;

  nextTaskId(): number {
    return ++this.taskId;
  }

  nextProfileId(): number {
    return ++this.profileId;
  }
}

// =============================================================================
// XML Helpers
// =============================================================================

const escapeXml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const elem = (
  tag: string,
  content: string | number | boolean,
  attrs: Record<string, string> = {}
): string => {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join("");
  const contentStr =
    typeof content === "string" ? escapeXml(content) : String(content);
  return `<${tag}${attrStr}>${contentStr}</${tag}>`;
};

const elemWithChildren = (
  tag: string,
  attrs: Record<string, string>,
  children: string[]
): string => {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join("");
  // If all children are simple strings (not XML tags), escape them
  const childrenStr = children
    .filter(Boolean)
    .map(c => c.startsWith("<") ? c : escapeXml(c))
    .join("\n");
  return `<${tag}${attrStr}>\n${childrenStr}\n</${tag}>`;
};

// =============================================================================
// Action Code Mapping
// =============================================================================

const ACTION_CODES: Record<string, number> = {
  FlashAction: 548,
  PopupAction: 550,
  SayAction: 38,
  VibrateAction: 61,
  NotifyAction: 523,
  SetVariableAction: 547,
  ClearVariableAction: 549,
  PerformTaskAction: 130,
  WaitAction: 30,
  StopAction: 137,
  IfAction: 37,
  ElseAction: 38,
  EndIfAction: 39,
  HttpRequestAction: 339,
  BrowseUrlAction: 104,
  SendSmsAction: 15,
  WriteFileAction: 417,
  ReadFileAction: 416,
  ShellAction: 123,
  JavaScriptletAction: 129,
  JavaScriptAction: 354,
  ShowSceneAction: 566,
  HideSceneAction: 567,
  SetWifiAction: 202,
  SetBluetoothAction: 204,
  SetVolumeAction: 207,
  LaunchAppAction: 145,
  ProfileStatusAction: 133,
};

// =============================================================================
// Action Compilation
// =============================================================================

const compileAction = (action: Action, index: number): string => {
  const tag = action._tag;
  const code = ACTION_CODES[tag] ?? 0;
  const children: string[] = [elem("code", code)];

  switch (action._tag) {
    case "FlashAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.message])
      );
      if (action.long) {
        children.push(elem("Int", 1, { sr: "arg1", val: "1" }));
      }
      break;

    case "PopupAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.title]),
        elemWithChildren("Str", { sr: "arg1", ve: "3" }, [action.text]),
        elem("Int", action.timeout ?? 0, {
          sr: "arg2",
          val: String(action.timeout ?? 0),
        })
      );
      break;

    case "SayAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.text]),
        elem("Int", action.pitch ?? 5, {
          sr: "arg1",
          val: String(action.pitch ?? 5),
        }),
        elem("Int", action.speed ?? 5, {
          sr: "arg2",
          val: String(action.speed ?? 5),
        })
      );
      break;

    case "SetVariableAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.name]),
        elemWithChildren("Str", { sr: "arg1", ve: "3" }, [action.value])
      );
      if (action.append) {
        children.push(elem("Int", 1, { sr: "arg2", val: "1" }));
      }
      if (action.doMaths) {
        children.push(elem("Int", 1, { sr: "arg3", val: "1" }));
      }
      break;

    case "ClearVariableAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.name])
      );
      break;

    case "PerformTaskAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.taskName]),
        elem("Int", action.priority ?? 5, {
          sr: "arg1",
          val: String(action.priority ?? 5),
        })
      );
      if (action.param1) {
        children.push(
          elemWithChildren("Str", { sr: "arg2", ve: "3" }, [action.param1])
        );
      }
      if (action.param2) {
        children.push(
          elemWithChildren("Str", { sr: "arg3", ve: "3" }, [action.param2])
        );
      }
      break;

    case "WaitAction": {
      const totalMs =
        (action.hours ?? 0) * 3600000 +
        (action.minutes ?? 0) * 60000 +
        (action.seconds ?? 0) * 1000 +
        (action.milliseconds ?? 0);
      children.push(elem("Int", totalMs, { sr: "arg0", val: String(totalMs) }));
      break;
    }

    case "IfAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.lhs])
      );
      const opCodes: Record<string, number> = {
        eq: 0,
        neq: 1,
        lt: 2,
        gt: 3,
        lte: 4,
        gte: 5,
        matches: 6,
        not_matches: 7,
        set: 12,
        not_set: 13,
        contains: 8,
        not_contains: 9,
      };
      children.push(
        elem("Int", opCodes[action.operator] ?? 0, {
          sr: "arg1",
          val: String(opCodes[action.operator] ?? 0),
        })
      );
      if (action.rhs) {
        children.push(
          elemWithChildren("Str", { sr: "arg2", ve: "3" }, [action.rhs])
        );
      }
      break;

    case "HttpRequestAction": {
      const methodCodes: Record<string, number> = {
        GET: 0,
        POST: 1,
        PUT: 2,
        PATCH: 3,
        DELETE: 4,
        HEAD: 5,
        OPTIONS: 6,
      };
      children.push(
        elem("Int", methodCodes[action.method] ?? 0, {
          sr: "arg0",
          val: String(methodCodes[action.method] ?? 0),
        }),
        elemWithChildren("Str", { sr: "arg1", ve: "3" }, [action.url])
      );
      if (action.body) {
        children.push(
          elemWithChildren("Str", { sr: "arg2", ve: "3" }, [action.body])
        );
      }
      children.push(
        elemWithChildren("Str", { sr: "arg3", ve: "3" }, [
          action.outputVariable ?? "%http_data",
        ]),
        elem("Int", action.timeout ?? 30, {
          sr: "arg4",
          val: String(action.timeout ?? 30),
        })
      );
      break;
    }

    case "ShellAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.command]),
        elem("Int", action.root ? 1 : 0, {
          sr: "arg1",
          val: action.root ? "1" : "0",
        }),
        elem("Int", action.timeout ?? 60, {
          sr: "arg2",
          val: String(action.timeout ?? 60),
        }),
        elemWithChildren("Str", { sr: "arg3", ve: "3" }, [
          action.outputVariable ?? "%shell_output",
        ])
      );
      break;

    case "JavaScriptletAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.code]),
        elem("Int", action.autoExit ? 1 : 0, {
          sr: "arg1",
          val: action.autoExit !== false ? "1" : "0",
        }),
        elem("Int", action.timeout ?? 45, {
          sr: "arg2",
          val: String(action.timeout ?? 45),
        })
      );
      if (action.libraries && action.libraries.length > 0) {
        children.push(
          elemWithChildren("Str", { sr: "arg3", ve: "3" }, [
            action.libraries.join("\n"),
          ])
        );
      }
      break;

    case "JavaScriptAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.path]),
        elem("Int", action.timeout ?? 45, {
          sr: "arg1",
          val: String(action.timeout ?? 45),
        })
      );
      break;

    case "WriteFileAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.path]),
        elemWithChildren("Str", { sr: "arg1", ve: "3" }, [action.text]),
        elem("Int", action.append ? 1 : 0, {
          sr: "arg2",
          val: action.append ? "1" : "0",
        })
      );
      break;

    case "ReadFileAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.path]),
        elemWithChildren("Str", { sr: "arg1", ve: "3" }, [
          action.outputVariable ?? "%file_content",
        ])
      );
      break;

    case "SetWifiAction":
      children.push(
        elem("Int", action.enabled ? 1 : 0, {
          sr: "arg0",
          val: action.enabled ? "1" : "0",
        })
      );
      break;

    case "SetBluetoothAction":
      children.push(
        elem("Int", action.enabled ? 1 : 0, {
          sr: "arg0",
          val: action.enabled ? "1" : "0",
        })
      );
      break;

    case "SetVolumeAction": {
      const streamCodes: Record<string, number> = {
        alarm: 0,
        bluetooth: 1,
        call: 2,
        dtmf: 3,
        media: 4,
        notification: 5,
        ringer: 6,
        system: 7,
      };
      children.push(
        elem("Int", streamCodes[action.stream] ?? 4, {
          sr: "arg0",
          val: String(streamCodes[action.stream] ?? 4),
        }),
        elem("Int", action.level, { sr: "arg1", val: String(action.level) }),
        elem("Int", action.display ? 1 : 0, {
          sr: "arg2",
          val: action.display ? "1" : "0",
        }),
        elem("Int", action.sound ? 1 : 0, {
          sr: "arg3",
          val: action.sound ? "1" : "0",
        })
      );
      break;
    }

    case "ShowSceneAction": {
      const displayCodes: Record<string, number> = {
        Overlay: 0,
        OverBlocking: 1,
        OverBlockFullDisplay: 2,
        Dialog: 3,
        DialogBlur: 4,
        DialogDim: 5,
        ActivityFullWindow: 6,
        ActivityFullDisplay: 7,
        ActivityFullDisplayNoTitle: 8,
      };
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.name]),
        elem("Int", displayCodes[action.displayAs ?? "Dialog"] ?? 3, {
          sr: "arg1",
          val: String(displayCodes[action.displayAs ?? "Dialog"] ?? 3),
        }),
        elem("Int", action.hOffset ?? 0, {
          sr: "arg2",
          val: String(action.hOffset ?? 0),
        }),
        elem("Int", action.vOffset ?? 0, {
          sr: "arg3",
          val: String(action.vOffset ?? 0),
        }),
        elem("Int", action.showExitIcon ? 1 : 0, {
          sr: "arg4",
          val: action.showExitIcon ? "1" : "0",
        })
      );
      break;
    }

    case "HideSceneAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.name])
      );
      break;

    case "LaunchAppAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.app])
      );
      if (action.data) {
        children.push(
          elemWithChildren("Str", { sr: "arg1", ve: "3" }, [action.data])
        );
      }
      if (action.excludeFromRecents) {
        children.push(elem("Int", 1, { sr: "arg2", val: "1" }));
      }
      break;

    case "VibrateAction":
      children.push(
        elem("Int", action.duration, { sr: "arg0", val: String(action.duration) })
      );
      break;

    case "ProfileStatusAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.name]),
        elem("Int", action.enabled ? 1 : 0, {
          sr: "arg1",
          val: action.enabled ? "1" : "0",
        })
      );
      break;

    case "BrowseUrlAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.url])
      );
      break;

    case "SendSmsAction":
      children.push(
        elemWithChildren("Str", { sr: "arg0", ve: "3" }, [action.number]),
        elemWithChildren("Str", { sr: "arg1", ve: "3" }, [action.message]),
        elem("Int", action.store !== false ? 1 : 0, {
          sr: "arg2",
          val: action.store !== false ? "1" : "0",
        })
      );
      break;
  }

  if (action.label) {
    children.push(elem("label", action.label));
  }

  if (action.continueOnError) {
    children.push(elem("se", "true"));
  }

  return elemWithChildren("Action", { sr: `act${index}`, ve: VE_TASK }, children);
};

// =============================================================================
// Trigger Compilation
// =============================================================================

const dayToNumber = (day: string): number => {
  const days: Record<string, number> = {
    sunday: 1,
    monday: 2,
    tuesday: 3,
    wednesday: 4,
    thursday: 5,
    friday: 6,
    saturday: 7,
  };
  return days[day] ?? 0;
};

const monthToNumber = (month: string): number => {
  const months: Record<string, number> = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };
  return months[month] ?? 0;
};

const compileTrigger = (trigger: Trigger, index: number): string => {
  const children: string[] = [];

  switch (trigger._tag) {
    case "TimeTrigger": {
      children.push(
        elem("fh", trigger.from.hour),
        elem("fm", trigger.from.minute)
      );
      if (trigger.to) {
        children.push(elem("th", trigger.to.hour), elem("tm", trigger.to.minute));
      }
      if (trigger.repeatMinutes && trigger.repeatMinutes > 0) {
        children.push(elem("rep", trigger.repeatMinutes));
      }
      if (trigger.days && trigger.days.length > 0) {
        const dayBits = trigger.days.reduce(
          (acc, day) => acc | (1 << dayToNumber(day)),
          0
        );
        children.push(elem("days", dayBits));
      }
      if (trigger.months && trigger.months.length > 0) {
        const monthBits = trigger.months.reduce(
          (acc, month) => acc | (1 << monthToNumber(month)),
          0
        );
        children.push(elem("months", monthBits));
      }
      return elemWithChildren(
        "Time",
        { sr: `con${index}`, ve: VE_PROFILE },
        children
      );
    }

    case "LocationTrigger":
      children.push(
        elem("lat", trigger.latitude.toFixed(6)),
        elem("long", trigger.longitude.toFixed(6)),
        elem("rad", trigger.radius)
      );
      return elemWithChildren(
        "Loc",
        { sr: `con${index}`, ve: VE_PROFILE },
        children
      );

    case "WifiTrigger":
      if (trigger.ssid) children.push(elem("ssid", trigger.ssid));
      if (trigger.mac) children.push(elem("mac", trigger.mac));
      children.push(elem("active", trigger.connected ? 1 : 0));
      return elemWithChildren("State", { sr: `con${index}`, ve: VE_PROFILE }, [
        elem("code", 461),
        ...children,
      ]);

    case "BluetoothTrigger":
      if (trigger.name) children.push(elem("name", trigger.name));
      if (trigger.address) children.push(elem("addr", trigger.address));
      children.push(elem("active", trigger.connected ? 1 : 0));
      return elemWithChildren("State", { sr: `con${index}`, ve: VE_PROFILE }, [
        elem("code", 462),
        ...children,
      ]);

    case "AppTrigger":
      children.push(elem("app", trigger.app));
      if (trigger.activity) children.push(elem("act", trigger.activity));
      return elemWithChildren(
        "App",
        { sr: `con${index}`, ve: VE_PROFILE },
        children
      );

    case "EventTrigger": {
      const eventCodes: Record<string, number> = {
        alarm_clock: 300,
        alarm_done: 301,
        battery_changed: 201,
        display_off: 208,
        display_on: 209,
        notification: 500,
        shake: 410,
        variable_set: 700,
      };
      children.push(elem("code", eventCodes[trigger.event] ?? 0));
      if (trigger.pattern) {
        children.push(elem("pat", trigger.pattern));
      }
      return elemWithChildren(
        "Event",
        { sr: `con${index}`, ve: VE_PROFILE },
        children
      );
    }

    case "NotificationTrigger":
      children.push(elem("code", 500));
      if (trigger.ownerApp) children.push(elem("app", trigger.ownerApp));
      if (trigger.title) children.push(elem("title", trigger.title));
      if (trigger.text) children.push(elem("text", trigger.text));
      return elemWithChildren(
        "Event",
        { sr: `con${index}`, ve: VE_PROFILE },
        children
      );

    case "StateTrigger": {
      const stateCodes: Record<string, number> = {
        airplane_mode: 410,
        battery: 412,
        bluetooth_connected: 462,
        wifi_connected: 461,
        variable_value: 590,
      };
      children.push(elem("code", stateCodes[trigger.state] ?? 0));
      if (trigger.params) {
        Object.entries(trigger.params).forEach(([k, v]) => {
          children.push(elem(k, v));
        });
      }
      return elemWithChildren(
        "State",
        { sr: `con${index}`, ve: VE_PROFILE },
        children
      );
    }

    case "BatteryStateTrigger":
      children.push(
        elem("code", 412),
        elem("from", trigger.from),
        elem("to", trigger.to)
      );
      return elemWithChildren(
        "State",
        { sr: `con${index}`, ve: VE_PROFILE },
        children
      );

    case "VariableTrigger": {
      const varOpCodes: Record<string, number> = {
        equals: 0,
        not_equals: 1,
        matches: 2,
        not_matches: 3,
        less_than: 4,
        greater_than: 5,
        is_set: 6,
        is_not_set: 7,
      };
      children.push(
        elem("code", 590),
        elem("var", trigger.name),
        elem("op", varOpCodes[trigger.operator] ?? 0)
      );
      if (trigger.value) children.push(elem("val", trigger.value));
      return elemWithChildren(
        "State",
        { sr: `con${index}`, ve: VE_PROFILE },
        children
      );
    }
  }
};

// =============================================================================
// Task Compilation
// =============================================================================

const compileTask = (task: Task, id: number): string => {
  const children: string[] = [elem("id", id), elem("nme", task.name)];

  if (task.collision && task.collision !== "abort_new") {
    const rtyValues: Record<string, number> = {
      abort_existing: 1,
      run_both: 2,
    };
    children.push(elem("rty", rtyValues[task.collision] ?? 0));
  }

  if (task.priority !== undefined && task.priority !== 5) {
    children.push(elem("pri", task.priority));
  }

  if (task.keepAwake) {
    children.push(elem("stayawake", "true"));
  }

  task.actions.forEach((action, idx) => {
    children.push(compileAction(action, idx));
  });

  return elemWithChildren("Task", { sr: `task${id}` }, children);
};

// =============================================================================
// Profile Compilation
// =============================================================================

const compileProfile = (
  profile: Profile,
  profileId: number,
  entryTaskId: number,
  exitTaskId?: number
): string => {
  const children: string[] = [
    elem("id", profileId),
    elem("nme", profile.name),
    elem("mid0", entryTaskId),
  ];

  if (exitTaskId !== undefined) {
    children.push(elem("mid1", exitTaskId));
  }

  if (!profile.enabled) {
    children.push(elem("enc", 1));
  }

  profile.triggers.forEach((trigger, idx) => {
    children.push(compileTrigger(trigger, idx));
  });

  return elemWithChildren(
    "Profile",
    { sr: `prof${profileId}`, ve: VE_PROFILE },
    children
  );
};

// =============================================================================
// Compiler Service
// =============================================================================

export interface TaskerCompilerService {
  readonly compileTask: (
    task: Task
  ) => Effect.Effect<CompiledOutput, CompilerError>;

  readonly compileProfile: (
    profile: Profile
  ) => Effect.Effect<CompiledOutput[], CompilerError>;

  readonly compileProject: (
    project: Project
  ) => Effect.Effect<CompiledOutput, CompilerError>;
}

export class TaskerCompiler extends Context.Tag("TaskerCompiler")<
  TaskerCompiler,
  TaskerCompilerService
>() {}

/** Create the compiler service */
export const TaskerCompilerLive = Layer.succeed(TaskerCompiler, {
  compileTask: (task) =>
    Effect.sync(() => {
      const idGen = new IdGenerator();
      const taskId = idGen.nextTaskId();

      const taskXml = compileTask(task, taskId);
      const content = `<?xml version="1.0" encoding="UTF-8"?>
<TaskerData sr="" dvi="${DVI}" tv="${TASKER_VERSION}">
${taskXml}
</TaskerData>`;

      return {
        filename: `${task.name}.tsk.xml`,
        content,
        type: "task" as const,
      };
    }),

  compileProfile: (profile) =>
    Effect.sync(() => {
      const idGen = new IdGenerator();
      const outputs: CompiledOutput[] = [];

      let entryTaskId: number;
      let entryTaskXml: string;
      if (typeof profile.entry === "string") {
        entryTaskId = idGen.nextTaskId();
        entryTaskXml = elemWithChildren("Task", { sr: `task${entryTaskId}` }, [
          elem("id", entryTaskId),
          elem("nme", profile.entry),
        ]);
      } else {
        entryTaskId = idGen.nextTaskId();
        entryTaskXml = compileTask(profile.entry, entryTaskId);
        outputs.push({
          filename: `${profile.entry.name}.tsk.xml`,
          content: `<?xml version="1.0" encoding="UTF-8"?>
<TaskerData sr="" dvi="${DVI}" tv="${TASKER_VERSION}">
${entryTaskXml}
</TaskerData>`,
          type: "task",
        });
      }

      let exitTaskId: number | undefined;
      let exitTaskXml: string | undefined;
      if (profile.exit) {
        if (typeof profile.exit === "string") {
          exitTaskId = idGen.nextTaskId();
          exitTaskXml = elemWithChildren("Task", { sr: `task${exitTaskId}` }, [
            elem("id", exitTaskId),
            elem("nme", profile.exit),
          ]);
        } else {
          exitTaskId = idGen.nextTaskId();
          exitTaskXml = compileTask(profile.exit, exitTaskId);
          outputs.push({
            filename: `${profile.exit.name}.tsk.xml`,
            content: `<?xml version="1.0" encoding="UTF-8"?>
<TaskerData sr="" dvi="${DVI}" tv="${TASKER_VERSION}">
${exitTaskXml}
</TaskerData>`,
            type: "task",
          });
        }
      }

      const profileId = idGen.nextProfileId();
      const profileXml = compileProfile(
        profile,
        profileId,
        entryTaskId,
        exitTaskId
      );

      const content = `<?xml version="1.0" encoding="UTF-8"?>
<TaskerData sr="" dvi="${DVI}" tv="${TASKER_VERSION}">
${profileXml}
${entryTaskXml}
${exitTaskXml ?? ""}
</TaskerData>`;

      outputs.push({
        filename: `${profile.name}.prf.xml`,
        content,
        type: "profile",
      });

      return outputs;
    }),

  compileProject: (project) =>
    Effect.sync(() => {
      const idGen = new IdGenerator();
      const profileXmls: string[] = [];
      const taskXmls: string[] = [];
      const profileIds: number[] = [];
      const taskIds: number[] = [];

      for (const task of project.tasks ?? []) {
        const taskId = idGen.nextTaskId();
        taskIds.push(taskId);
        taskXmls.push(compileTask(task, taskId));
      }

      for (const profile of project.profiles ?? []) {
        let entryTaskId: number;
        if (typeof profile.entry === "string") {
          entryTaskId = idGen.nextTaskId();
          taskIds.push(entryTaskId);
          taskXmls.push(
            elemWithChildren("Task", { sr: `task${entryTaskId}` }, [
              elem("id", entryTaskId),
              elem("nme", profile.entry),
            ])
          );
        } else {
          entryTaskId = idGen.nextTaskId();
          taskIds.push(entryTaskId);
          taskXmls.push(compileTask(profile.entry, entryTaskId));
        }

        let exitTaskId: number | undefined;
        if (profile.exit) {
          if (typeof profile.exit === "string") {
            exitTaskId = idGen.nextTaskId();
            taskIds.push(exitTaskId);
            taskXmls.push(
              elemWithChildren("Task", { sr: `task${exitTaskId}` }, [
                elem("id", exitTaskId),
                elem("nme", profile.exit),
              ])
            );
          } else {
            exitTaskId = idGen.nextTaskId();
            taskIds.push(exitTaskId);
            taskXmls.push(compileTask(profile.exit, exitTaskId));
          }
        }

        const profileId = idGen.nextProfileId();
        profileIds.push(profileId);
        profileXmls.push(
          compileProfile(profile, profileId, entryTaskId, exitTaskId)
        );
      }

      const projectXml = elemWithChildren(
        "Project",
        { sr: "proj0", ve: VE_PROFILE },
        [
          elem("name", project.name),
          ...(profileIds.length > 0
            ? [elem("pids", profileIds.join(","))]
            : []),
          ...(taskIds.length > 0 ? [elem("tids", taskIds.join(","))] : []),
        ]
      );

      const content = `<?xml version="1.0" encoding="UTF-8"?>
<TaskerData sr="" dvi="${DVI}" tv="${TASKER_VERSION}">
${projectXml}
${profileXmls.join("\n")}
${taskXmls.join("\n")}
</TaskerData>`;

      return {
        filename: `${project.name}.prj.xml`,
        content,
        type: "project" as const,
      };
    }),
});

// =============================================================================
// Convenience Functions
// =============================================================================

export const compileTaskToXml = (
  task: Task
): Effect.Effect<string, CompilerError> =>
  Effect.gen(function* () {
    const compiler = yield* TaskerCompiler;
    const output = yield* compiler.compileTask(task);
    return output.content;
  }).pipe(Effect.provide(TaskerCompilerLive));

export const compileProfileToXml = (
  profile: Profile
): Effect.Effect<CompiledOutput[], CompilerError> =>
  Effect.gen(function* () {
    const compiler = yield* TaskerCompiler;
    return yield* compiler.compileProfile(profile);
  }).pipe(Effect.provide(TaskerCompilerLive));

export const compileProjectToXml = (
  project: Project
): Effect.Effect<string, CompilerError> =>
  Effect.gen(function* () {
    const compiler = yield* TaskerCompiler;
    const output = yield* compiler.compileProject(project);
    return output.content;
  }).pipe(Effect.provide(TaskerCompilerLive));
