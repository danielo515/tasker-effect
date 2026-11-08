import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Action, Profile, Project, Task, Trigger } from "../src/profile.js";
import {
  CLIPBOARD_CHANGED_EVENT_CODE,
  DISPATCH_TASK_NAME,
  compileProfileXml,
  compileProjectFiles,
  compileTaskXml,
} from "../src/compiler.js";

const TEST_REPO = { owner: "acme", repo: "automations" } as const;

const fixture = (name: string): string =>
  readFileSync(path.join(__dirname, "fixtures", "tasker-exports", name), "utf8");

const flashTask = (name: string) =>
  new Task({ name, actions: [Action.flash("hi")] });

const clipboardProfile = new Profile({
  name: "Clipboard History",
  triggers: [
    Trigger.clipboardChanged(),
    Trigger.appOpened("Bitwarden", {
      packageName: "com.x8bit.bitwarden",
      invert: true,
    }),
  ],
  enter: flashTask("Record"),
});

/** The elements of `tag` (with content) in an XML string */
const elements = (xml: string, tag: string): Array<string> =>
  [...xml.matchAll(new RegExp(`<${tag}[ >][\\s\\S]*?</${tag}>`, "g"))].map(
    (match) => match[0]
  );

/** Text of every `<child>` inside an element, as a sorted "child=value" list */
const leaves = (element: string): Array<string> =>
  [...element.matchAll(/<(code|flags|label0|pkg0|nme)>([^<]*)<\//g)]
    .map((match) => `${match[1]}=${match[2]}`)
    .sort();

describe("compileProfileXml", () => {
  it("matches the real Tasker export for the clipboard profile's contexts", () => {
    const xml = compileProfileXml(clipboardProfile)!;
    const real = fixture("clipboard-history.prf.xml");
    const event = elements(xml, "Event")[0]!;
    const realEvent = elements(real, "Event")[0]!;
    expect(leaves(event)).toEqual(leaves(realEvent));
    expect(event).toContain(`<code>${CLIPBOARD_CHANGED_EVENT_CODE}</code>`);
    expect(event).toContain('<Int sr="arg1" val="1"/>');
    expect(realEvent).toContain('<Int sr="arg1" val="1"/>');
    // The real export also carries the activity class (cls0); the package
    // alone identifies the app.
    expect(leaves(elements(xml, "App")[0]!)).toEqual(
      leaves(elements(real, "App")[0]!)
    );
  });

  it("puts the event first and wires anonymous dispatcher tasks", () => {
    const profile = new Profile({
      name: "P",
      triggers: [
        Trigger.appOpened("A", { packageName: "com.a" }),
        Trigger.clipboardChanged({ ignoreSetByTasker: false }),
      ],
      enter: flashTask("In"),
      exit: flashTask("Out"),
    });
    const xml = compileProfileXml(profile, { jsDir: "/x/" })!;
    expect(xml.indexOf('<Event sr="con0"')).toBeGreaterThan(0);
    expect(xml).toContain('<App sr="con1" ve="2">');
    expect(xml).toContain('<Int sr="arg1" val="0"/>');
    expect(xml).not.toContain("<flags>2</flags>");
    expect(xml).toContain("<mid0>101</mid0>");
    expect(xml).toContain("<mid1>102</mid1>");
    expect(elements(xml, "Task")).toHaveLength(2);
    for (const task of elements(xml, "Task")) {
      expect(task).not.toContain("<nme>");
      expect(task).toContain("<code>131</code>");
      expect(task).toContain("/x/dispatcher.js");
    }
    // Only the profile itself is named.
    expect([...xml.matchAll(/<nme>([^<]*)</g)].map((m) => m[1])).toEqual(["P"]);
  });

  it("returns undefined when a trigger has no known XML form", () => {
    for (const triggers of [
      [Trigger.event("Display On")],
      [Trigger.appOpened("No Package")],
      [Trigger.clipboardChanged(), Trigger.clipboardChanged()],
    ] as const) {
      const profile = new Profile({
        name: "P",
        triggers: [...triggers] as never,
        enter: flashTask("In"),
      });
      expect(compileProfileXml(profile)).toBeUndefined();
    }
  });
});

describe("compileTaskXml", () => {
  it("matches the hand-written task that imported fine on a device", () => {
    const xml = compileTaskXml(flashTask("Show Clipboard History"));
    const real = fixture("show-clipboard-history.tsk.xml");
    const strip = (s: string) =>
      elements(s, "Action")[0]!.replace(/\s+/g, "");
    expect(strip(xml)).toBe(strip(real));
    expect(xml).toContain(`<Str sr="arg0" ve="3">${DISPATCH_TASK_NAME}</Str>`);
    expect(xml).toContain("<nme>Show Clipboard History</nme>");
  });
});

describe("compileProjectFiles importable XML", () => {
  const project = new Project({
    name: "P",
    profiles: [
      clipboardProfile,
      new Profile({
        name: "Manual",
        triggers: [Trigger.event("Display On")],
        enter: flashTask("M"),
      }),
    ],
    tasks: [flashTask("Show It")],
  });
  const files = compileProjectFiles(project, { repo: TEST_REPO });
  const names = files.map((file) => file.filename);

  it("emits .prf.xml only for profiles with known triggers, .tsk.xml per task", () => {
    expect(names).toContain("clipboard-history.prf.xml");
    expect(names).not.toContain("manual.prf.xml");
    expect(names).toContain("show-it.tsk.xml");
    const readme = files.find((file) => file.filename === "README.md")!.content;
    expect(readme).toContain("Import `clipboard-history.prf.xml`");
    expect(readme).toContain("Triggers to configure in the Tasker UI:");
    expect(readme).toContain("import `show-it.tsk.xml`");
  });

  it("rejects a task whose XML filename collides with a reserved one", () => {
    expect(() =>
      compileProjectFiles(
        new Project({
          name: "P",
          tasks: [flashTask("a b"), flashTask("a-b")],
        }),
        { repo: TEST_REPO }
      )
    ).toThrow(/a-b\.tsk\.xml/);
  });
});
