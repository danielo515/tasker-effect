import { describe, expect, test } from "bun:test";
import { Action, Trigger, Task, Profile, Project } from "../src/profile.js";
import {
  DISPATCHER_FILENAME,
  DISPATCH_TASK_NAME,
  TASKER_IMPORT_XML_FILENAME,
  compileDispatcherJs,
  compileProjectFiles,
  taskerImportXml,
} from "../src/compiler.js";

const expectValidJs = (code: string) => {
  expect(() => new Function(code)).not.toThrow();
};

const makeProject = () =>
  new Project({
    name: "Dispatch Demo",
    profiles: [
      new Profile({
        name: "Morning Routine",
        triggers: [Trigger.time({ hour: 7, minute: 0 })],
        enter: new Task({ name: "Wake", actions: [Action.flash("up")] }),
        exit: new Task({ name: "Sleep", actions: [Action.flash("down")] }),
      }),
      new Profile({
        name: "Enter Only",
        triggers: [Trigger.wifiConnected("Net")],
        enter: new Task({ name: "Arrive", actions: [Action.flash("hello")] }),
      }),
    ],
    tasks: [
      new Task({ name: "Weather Check", actions: [Action.flash("weather")] }),
    ],
  });

describe("compileDispatcherJs", () => {
  test("embeds the profile and task maps with slug filenames", () => {
    const source = compileDispatcherJs(makeProject());

    expect(source).toContain(
      '"Morning Routine": { enter: "morning-routine.enter.js", exit: "morning-routine.exit.js" },'
    );
    expect(source).toContain('"Enter Only": { enter: "enter-only.enter.js" },');
    expect(source).not.toContain("enter-only.exit.js");
    expect(source).toContain('"Weather Check": "weather-check.js",');
    expectValidJs(source);
  });

  test("resolves via %par1/%par2 and falls back to %caller1 profile detection", () => {
    const source = compileDispatcherJs(makeProject());
    expect(source).toContain('local("par1")');
    expect(source).toContain('local("par2")');
    expect(source).toContain('local("caller1")');
    expect(source).toContain("profile=(enter|exit)");
    expect(source).toContain("eval(source);");
    expect(source).toContain("readFile(path)");
  });

  test("uses %TE_JS_DIR with the documented default", () => {
    const source = compileDispatcherJs(makeProject());
    expect(source).toContain('global("TE_JS_DIR")');
    expect(source).toContain('"/sdcard/Tasker/js/"');
  });

  test("escapes names that would break the emitted source", () => {
    const project = new Project({
      name: "Escapes",
      tasks: [
        new Task({
          name: 'He said "run"\nnow',
          actions: [Action.flash("x")],
        }),
      ],
    });
    const source = compileDispatcherJs(project);
    expect(source).toContain('"He said \\"run\\"\\nnow": "he-said-run-now.js",');
    expectValidJs(source);
  });

  test("flashes clear errors for unknown names", () => {
    const source = compileDispatcherJs(makeProject());
    expect(source).toContain("unknown profile or task");
    expect(source).toContain("could not read");
  });
});

describe("taskerImportXml", () => {
  test("contains the file-based JavaScript action (code 131) with Auto Exit on", () => {
    const xml = taskerImportXml();
    expect(xml).toContain("<code>131</code>");
    expect(xml).toContain(
      '<Str sr="arg0" ve="3">/sdcard/Tasker/js/dispatcher.js</Str>'
    );
    expect(xml).toContain('<Int sr="arg2" val="1"/>');
    expect(xml).toContain(`<nme>${DISPATCH_TASK_NAME}</nme>`);
    expect(xml).toContain('<TaskerData sr="" dvi="1"');
  });

  test("supports a custom dispatcher path, XML-escaped", () => {
    const xml = taskerImportXml({ dispatcherPath: "/a/b & c/dispatcher.js" });
    expect(xml).toContain('<Str sr="arg0" ve="3">/a/b &amp; c/dispatcher.js</Str>');
  });

  test("is static scaffolding: identical across projects and free of compiled content", () => {
    const projectA = makeProject();
    const projectB = new Project({
      name: "Totally Different",
      tasks: [
        new Task({ name: "Unique Marker Task", actions: [Action.flash("zz")] }),
      ],
    });

    const xmlA = compileProjectFiles(projectA).find(
      (file) => file.filename === TASKER_IMPORT_XML_FILENAME
    );
    const xmlB = compileProjectFiles(projectB).find(
      (file) => file.filename === TASKER_IMPORT_XML_FILENAME
    );

    expect(xmlA).toBeDefined();
    expect(xmlA!.content).toBe(xmlB!.content);
    expect(xmlA!.kind).toBe("tasker-xml");
    // No per-task content: no names, no compiled JS, only the dispatcher pointer.
    for (const marker of [
      "Morning Routine",
      "Weather Check",
      "Unique Marker Task",
      "flash(",
      "JavaScriptlet",
      "<code>129</code>",
    ]) {
      expect(xmlA!.content).not.toContain(marker);
    }
  });
});

describe("compileProjectFiles with dispatcher", () => {
  test("includes dispatcher.js and the import XML, and documents them in the README", () => {
    const files = compileProjectFiles(makeProject());
    const names = files.map((file) => file.filename);
    expect(names).toContain(DISPATCHER_FILENAME);
    expect(names).toContain(TASKER_IMPORT_XML_FILENAME);

    const dispatcher = files.find((file) => file.filename === DISPATCHER_FILENAME);
    expect(dispatcher?.kind).toBe("dispatcher-js");

    const readme = files.find((file) => file.filename === "README.md");
    expect(readme?.content).toContain(DISPATCH_TASK_NAME);
    expect(readme?.content).toContain(TASKER_IMPORT_XML_FILENAME);
    expect(readme?.content).toContain("%caller1");
  });
});
