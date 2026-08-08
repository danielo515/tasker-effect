import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  task,
  profile,
  project,
  time,
  wifi,
  flash,
  setVar,
  performTask,
  javascriptlet,
  shell,
} from "../src/profile.js";
import {
  compileTaskToXml,
  compileProfileToXml,
  compileProjectToXml,
} from "../src/compiler.js";

describe("Task Compilation", () => {
  test("compiles simple task", async () => {
    const t = task("Test Task", [flash("Hello World")]);

    const xml = await Effect.runPromise(compileTaskToXml(t));

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<TaskerData");
    expect(xml).toContain("<Task");
    expect(xml).toContain("<nme>Test Task</nme>");
    expect(xml).toContain("<code>548</code>"); // Flash action code
    expect(xml).toContain("Hello World");
  });

  test("compiles task with multiple actions", async () => {
    const t = task("Multi Action Task", [
      flash("Start"),
      setVar("%counter", "0"),
      performTask("Other Task"),
      flash("End"),
    ]);

    const xml = await Effect.runPromise(compileTaskToXml(t));

    expect(xml).toContain("act0");
    expect(xml).toContain("act1");
    expect(xml).toContain("act2");
    expect(xml).toContain("act3");
  });

  test("compiles task with shell action", async () => {
    const t = task("Shell Task", [
      shell("echo hello", { root: true, timeout: 30 }),
    ]);

    const xml = await Effect.runPromise(compileTaskToXml(t));

    expect(xml).toContain("<code>123</code>"); // Shell action code
    expect(xml).toContain("echo hello");
  });

  test("compiles task with JavaScriptlet", async () => {
    const code = "var x = 1 + 1; setGlobal('result', x);";
    const t = task("JS Task", [javascriptlet(code)]);

    const xml = await Effect.runPromise(compileTaskToXml(t));

    expect(xml).toContain("<code>129</code>"); // JavaScriptlet code
    expect(xml).toContain("var x = 1 + 1");
  });

  test("handles special XML characters", async () => {
    const t = task("Special Chars", [
      flash("Hello <world> & 'friends' \"everyone\""),
    ]);

    const xml = await Effect.runPromise(compileTaskToXml(t));

    expect(xml).toContain("&lt;world&gt;");
    expect(xml).toContain("&amp;");
  });

  test("compiles setVar with doMaths", async () => {
    const t = task("Math Task", [
      setVar("%counter", "%counter + 1", { doMaths: true }),
    ]);

    const xml = await Effect.runPromise(compileTaskToXml(t));

    expect(xml).toContain("<code>547</code>"); // SetVariable code
    expect(xml).toContain("%counter + 1");
  });
});

describe("Profile Compilation", () => {
  test("compiles profile with time trigger", async () => {
    const p = profile(
      "Morning Profile",
      [time({ hour: 7, minute: 0 }, { to: { hour: 9, minute: 0 } })],
      task("Morning Task", [flash("Good morning!")])
    );

    const outputs = await Effect.runPromise(compileProfileToXml(p));

    expect(outputs.length).toBeGreaterThan(0);

    const profileOutput = outputs.find((o) => o.type === "profile");
    expect(profileOutput).toBeDefined();
    expect(profileOutput!.content).toContain("<Profile");
    expect(profileOutput!.content).toContain("<Time");
    expect(profileOutput!.content).toContain("<fh>7</fh>");
    expect(profileOutput!.content).toContain("<fm>0</fm>");
    expect(profileOutput!.content).toContain("<th>9</th>");
    expect(profileOutput!.content).toContain("<tm>0</tm>");
  });

  test("compiles profile with WiFi trigger", async () => {
    const p = profile(
      "Home WiFi Profile",
      [wifi({ ssid: "MyHomeNetwork" })],
      "Home Task"
    );

    const outputs = await Effect.runPromise(compileProfileToXml(p));

    const profileOutput = outputs.find((o) => o.type === "profile");
    expect(profileOutput!.content).toContain("<State");
    expect(profileOutput!.content).toContain("<ssid>MyHomeNetwork</ssid>");
  });

  test("compiles profile with entry and exit tasks", async () => {
    const p = profile(
      "Dual Task Profile",
      [time({ hour: 9, minute: 0 })],
      task("Entry Task", [flash("Entering")]),
      {
        exit: task("Exit Task", [flash("Exiting")]),
      }
    );

    const outputs = await Effect.runPromise(compileProfileToXml(p));

    expect(outputs.length).toBeGreaterThanOrEqual(2);

    const profileOutput = outputs.find((o) => o.type === "profile");
    expect(profileOutput!.content).toContain("<mid0>"); // Entry task ref
    expect(profileOutput!.content).toContain("<mid1>"); // Exit task ref
  });

  test("generates correct filenames", async () => {
    const p = profile(
      "My Profile",
      [time({ hour: 12, minute: 0 })],
      "Test Task"
    );

    const outputs = await Effect.runPromise(compileProfileToXml(p));

    const profileOutput = outputs.find((o) => o.type === "profile");
    expect(profileOutput!.filename).toBe("My Profile.prf.xml");
  });

  test("compiles profile with day filter", async () => {
    const p = profile(
      "Weekday Profile",
      [
        time(
          { hour: 9, minute: 0 },
          { days: ["monday", "tuesday", "wednesday", "thursday", "friday"] }
        ),
      ],
      "Work Task"
    );

    const outputs = await Effect.runPromise(compileProfileToXml(p));
    const profileOutput = outputs.find((o) => o.type === "profile");
    expect(profileOutput!.content).toContain("<days>");
  });
});

describe("Project Compilation", () => {
  test("compiles empty project", async () => {
    const p = project("Empty Project");

    const xml = await Effect.runPromise(compileProjectToXml(p));

    expect(xml).toContain("<Project");
    expect(xml).toContain("<name>Empty Project</name>");
  });

  test("compiles project with profiles and tasks", async () => {
    const p = project("My Project", {
      profiles: [
        profile(
          "Test Profile",
          [time({ hour: 8, minute: 0 })],
          task("Profile Task", [flash("Hello")])
        ),
      ],
      tasks: [task("Standalone Task", [flash("Standalone")])],
    });

    const xml = await Effect.runPromise(compileProjectToXml(p));

    expect(xml).toContain("<Project");
    expect(xml).toContain("<Profile");
    expect(xml).toContain("<Task");
    expect(xml).toContain("<pids>"); // Profile IDs
    expect(xml).toContain("<tids>"); // Task IDs
  });
});

describe("XML Structure", () => {
  test("includes TaskerData root with version info", async () => {
    const t = task("Test", [flash("Hi")]);
    const xml = await Effect.runPromise(compileTaskToXml(t));

    expect(xml).toMatch(/<TaskerData sr="" dvi="\d+" tv="[\d.]+[^"]*">/);
  });

  test("actions have proper sr and ve attributes", async () => {
    const t = task("Test", [flash("Hi")]);
    const xml = await Effect.runPromise(compileTaskToXml(t));

    expect(xml).toMatch(/<Action sr="act\d+" ve="\d+">/);
  });
});
