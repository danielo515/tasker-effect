import { describe, expect, test } from "bun:test";
import {
  type Task,
  type Profile,
  type Project,
  type TimeTrigger,
  type TimeSpec,
  type WifiTrigger,
  type BatteryStateTrigger,
  type FlashAction,
  type SetVariableAction,
  type JavaScriptletAction,
  time,
  wifi,
  battery,
  flash,
  setVar,
  performTask,
  javascriptlet,
  task,
  profile,
  project,
} from "../src/profile.js";

describe("time trigger", () => {
  test("creates basic time trigger", () => {
    const trigger = time({ hour: 9, minute: 0 });
    expect(trigger._tag).toBe("TimeTrigger");
    expect(trigger.from.hour).toBe(9);
    expect(trigger.from.minute).toBe(0);
  });

  test("creates time trigger with range", () => {
    const trigger = time({ hour: 9, minute: 0 }, { to: { hour: 17, minute: 0 } });
    expect(trigger.to?.hour).toBe(17);
    expect(trigger.to?.minute).toBe(0);
  });

  test("supports day filtering", () => {
    const trigger = time({ hour: 9, minute: 0 }, {
      days: ["monday", "wednesday", "friday"],
    });
    expect(trigger.days).toHaveLength(3);
    expect(trigger.days).toContain("monday");
  });

  test("supports repeat minutes", () => {
    const trigger = time({ hour: 9, minute: 0 }, { repeatMinutes: 30 });
    expect(trigger.repeatMinutes).toBe(30);
  });
});

describe("wifi trigger", () => {
  test("creates wifi trigger with SSID", () => {
    const trigger = wifi({ ssid: "MyNetwork" });
    expect(trigger._tag).toBe("WifiTrigger");
    expect(trigger.ssid).toBe("MyNetwork");
    expect(trigger.connected).toBe(true);
  });

  test("supports disconnected state", () => {
    const trigger = wifi({
      ssid: "MyNetwork",
      connected: false,
    });
    expect(trigger.connected).toBe(false);
  });

  test("defaults to connected", () => {
    const trigger = wifi();
    expect(trigger.connected).toBe(true);
  });
});

describe("battery trigger", () => {
  test("creates battery trigger", () => {
    const trigger = battery(0, 20);
    expect(trigger._tag).toBe("BatteryStateTrigger");
    expect(trigger.from).toBe(0);
    expect(trigger.to).toBe(20);
  });

  test("supports invert", () => {
    const trigger = battery(0, 20, true);
    expect(trigger.invert).toBe(true);
  });
});

describe("flash action", () => {
  test("creates flash action", () => {
    const action = flash("Hello!");
    expect(action._tag).toBe("FlashAction");
    expect(action.message).toBe("Hello!");
    expect(action.long).toBe(false);
  });

  test("supports long flash", () => {
    const action = flash("Hello!", true);
    expect(action.long).toBe(true);
  });
});

describe("setVar action", () => {
  test("creates set variable action", () => {
    const action = setVar("%myvar", "test");
    expect(action._tag).toBe("SetVariableAction");
    expect(action.name).toBe("%myvar");
    expect(action.value).toBe("test");
  });

  test("supports math mode", () => {
    const action = setVar("%counter", "%counter + 1", { doMaths: true });
    expect(action.doMaths).toBe(true);
  });

  test("supports append mode", () => {
    const action = setVar("%list", "item", { append: true });
    expect(action.append).toBe(true);
  });
});

describe("javascriptlet action", () => {
  test("creates javascriptlet action", () => {
    const code = "var x = 1 + 1; setGlobal('result', x);";
    const action = javascriptlet(code);
    expect(action._tag).toBe("JavaScriptletAction");
    expect(action.code).toBe(code);
    expect(action.autoExit).toBe(true);
  });

  test("supports libraries", () => {
    const action = javascriptlet("console.log('test')", {
      libraries: ["https://example.com/lib.js"],
    });
    expect(action.libraries).toHaveLength(1);
  });

  test("supports custom timeout", () => {
    const action = javascriptlet("longTask()", { timeout: 120 });
    expect(action.timeout).toBe(120);
  });
});

describe("task", () => {
  test("creates task with actions", () => {
    const t = task("My Task", [
      flash("Start"),
      setVar("%x", "1"),
    ]);
    expect(t.name).toBe("My Task");
    expect(t.actions).toHaveLength(2);
    expect(t.collision).toBe("abort_new");
    expect(t.priority).toBe(5);
  });

  test("supports collision handling", () => {
    const t = task("My Task", [], { collision: "run_both" });
    expect(t.collision).toBe("run_both");
  });

  test("supports keep awake", () => {
    const t = task("My Task", [], { keepAwake: true });
    expect(t.keepAwake).toBe(true);
  });
});

describe("profile", () => {
  test("creates profile with trigger and entry task", () => {
    const p = profile(
      "My Profile",
      [time({ hour: 9, minute: 0 })],
      "My Task"
    );
    expect(p.name).toBe("My Profile");
    expect(p.triggers).toHaveLength(1);
    expect(p.entry).toBe("My Task");
    expect(p.enabled).toBe(true);
  });

  test("supports inline entry task", () => {
    const p = profile(
      "My Profile",
      [wifi({ ssid: "Home" })],
      task("Home Entry", [flash("Home!")])
    );
    expect(typeof p.entry).toBe("object");
    expect((p.entry as Task).name).toBe("Home Entry");
  });

  test("supports exit task", () => {
    const p = profile(
      "My Profile",
      [time({ hour: 9, minute: 0 })],
      "Entry",
      { exit: "Exit" }
    );
    expect(p.exit).toBe("Exit");
  });

  test("supports description", () => {
    const p = profile(
      "My Profile",
      [time({ hour: 9, minute: 0 })],
      "My Task",
      { description: "My description" }
    );
    expect(p.description).toBe("My description");
  });
});

describe("project", () => {
  test("creates empty project", () => {
    const p = project("My Project");
    expect(p.name).toBe("My Project");
    expect(p.profiles).toHaveLength(0);
    expect(p.tasks).toHaveLength(0);
  });

  test("creates project with profiles and tasks", () => {
    const p = project("My Project", {
      profiles: [
        profile(
          "Test Profile",
          [wifi({ ssid: "*" })],
          "Test Task"
        ),
      ],
      tasks: [
        task("Test Task", [flash("Test")]),
      ],
    });
    expect(p.profiles).toHaveLength(1);
    expect(p.tasks).toHaveLength(1);
  });

  test("supports description", () => {
    const p = project("My Project", { description: "My project desc" });
    expect(p.description).toBe("My project desc");
  });
});

describe("helper functions", () => {
  test("performTask creates PerformTaskAction", () => {
    const action = performTask("Other Task");
    expect(action._tag).toBe("PerformTaskAction");
    expect(action.taskName).toBe("Other Task");
    expect(action.priority).toBeUndefined();
  });

  test("performTask with params", () => {
    const action = performTask("Other Task", {
      param1: "arg1",
      param2: "arg2",
      priority: 10,
    });
    expect(action.param1).toBe("arg1");
    expect(action.param2).toBe("arg2");
    expect(action.priority).toBe(10);
  });
});
