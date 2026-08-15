import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Action, Trigger, Task, Profile, Project, cond } from "../src/profile.js";
import {
  TaskerCompiler,
  compileTaskToJs,
  compileProfileFiles,
  compileProjectFiles,
  describeTrigger,
  slugify,
} from "../src/compiler.js";

const expectValidJs = (code: string) => {
  // Throws SyntaxError if the emitted code does not parse.
  expect(() => new Function(code)).not.toThrow();
};

describe("compileTaskToJs", () => {
  test("emits Tasker API calls for each action", () => {
    const task = new Task({
      name: "Morning Routine",
      actions: [
        Action.flash("Good morning!"),
        Action.setVolume("media", 5),
        Action.say("Time to wake up"),
        Action.setGlobal("%MODE", "day"),
      ],
    });

    const jsSource = compileTaskToJs(task);

    expect(jsSource).toContain('flash("Good morning!");');
    expect(jsSource).toContain("mediaVol(5, false, false);");
    expect(jsSource).toContain('say("Time to wake up"');
    expect(jsSource).toContain('setGlobal("MODE", "day");');
    expect(jsSource).toContain('"use strict";');
    expectValidJs(jsSource);
  });

  test("escapes quotes and newlines in strings", () => {
    const task = new Task({
      name: "Escapes",
      actions: [Action.flash('He said "hi"\nand left')],
    });
    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain('flash("He said \\"hi\\"\\nand left");');
    expectValidJs(jsSource);
  });

  test("compiles conditionals with else branches", () => {
    const task = new Task({
      name: "Battery Check",
      actions: [
        Action.when(
          cond("%BATT", "lt", "20"),
          [Action.flash("Low battery"), Action.setWifi(false)],
          [Action.flash("All good")]
        ),
      ],
    });

    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain('if (parseFloat(global("BATT")) < parseFloat("20")) {');
    expect(jsSource).toContain("} else {");
    expect(jsSource).toContain("setWifi(false);");
    expectValidJs(jsSource);
  });

  test("compiles HTTP requests to synchronous XHR", () => {
    const task = new Task({
      name: "Fetch Weather",
      actions: [
        Action.http("GET", "https://example.com/weather", {
          headers: { Accept: "application/json" },
          outputGlobal: "%WEATHER",
        }),
      ],
    });

    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain('xhr.open("GET", "https://example.com/weather", false);');
    expect(jsSource).toContain('xhr.setRequestHeader("Accept", "application/json");');
    expect(jsSource).toContain('setGlobal("WEATHER", __out);');
    expectValidJs(jsSource);
  });

  test("shell output lands in a global variable", () => {
    const task = new Task({
      name: "Uptime",
      actions: [Action.shell("uptime", { outputGlobal: "%UPTIME" })],
    });
    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain('__out = shell("uptime", false, 30);');
    expect(jsSource).toContain('setGlobal("UPTIME"');
    expectValidJs(jsSource);
  });

  test("raw JavaScript is inserted verbatim", () => {
    const task = new Task({
      name: "Custom",
      actions: [Action.js("var x = 1;\nflash(String(x));")],
    });
    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain("var x = 1;");
    expectValidJs(jsSource);
  });

  test("wraps everything in an error handler that flashes", () => {
    const task = new Task({ name: "T", actions: [Action.flash("x")] });
    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain("catch (err)");
    expect(jsSource).toContain('flash("Task \\"T\\" failed: " + err);');
  });
});

describe("compileProfileFiles", () => {
  test("emits enter and exit files", () => {
    const profile = new Profile({
      name: "Home WiFi",
      triggers: [Trigger.wifiConnected("MyNetwork")],
      enter: new Task({ name: "Arrive", actions: [Action.flash("Welcome home")] }),
      exit: new Task({ name: "Leave", actions: [Action.flash("Goodbye")] }),
    });

    const files = compileProfileFiles(profile);
    expect(files.map((f) => f.filename)).toEqual([
      "home-wifi.enter.js",
      "home-wifi.exit.js",
    ]);
    for (const file of files) expectValidJs(file.content);
  });
});

describe("compileProjectFiles", () => {
  test("bundles profiles, tasks and a setup README", () => {
    const project = new Project({
      name: "My Automations",
      profiles: [
        new Profile({
          name: "Low Battery",
          triggers: [Trigger.batteryLevel(0, 20)],
          enter: new Task({
            name: "Save Power",
            actions: [Action.setWifi(false)],
          }),
        }),
      ],
      tasks: [
        new Task({ name: "Greet", actions: [Action.flash("Hi")] }),
      ],
    });

    const files = compileProjectFiles(project);
    const names = files.map((f) => f.filename);
    expect(names).toContain("low-battery.enter.js");
    expect(names).toContain("greet.js");
    expect(names).toContain("README.md");

    const readme = files.find((f) => f.filename === "README.md");
    expect(readme?.content).toContain("Battery Level from 0% to 20%");
    expect(readme?.content).toContain("low-battery.enter.js");
  });
});

describe("TaskerCompiler service", () => {
  test("compileTask returns a CompiledFile", async () => {
    const program = Effect.gen(function* () {
      const compiler = yield* TaskerCompiler;
      return yield* compiler.compileTask(
        new Task({ name: "Service Task", actions: [Action.flash("via service")] })
      );
    });

    const file = await Effect.runPromise(
      program.pipe(Effect.provide(TaskerCompiler.Default))
    );
    expect(file.filename).toBe("service-task.js");
    expect(file.content).toContain('flash("via service");');
  });
});

describe("helpers", () => {
  test("slugify produces safe file names", () => {
    expect(slugify("Morning Routine!")).toBe("morning-routine");
    expect(slugify("  ")).toBe("task");
  });

  test("describeTrigger formats times", () => {
    const description = describeTrigger(
      Trigger.time({ hour: 7, minute: 5 }, { to: { hour: 9, minute: 0 } })
    );
    expect(description).toBe("Time from 07:05 to 09:00");
  });
});
