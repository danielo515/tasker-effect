import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Action, Profile, Project, Task, Trigger } from "../src/profile.js";
import {
  CLIPBOARD_CHANGED_EVENT_CODE,
  DISPATCH_TASK_NAME,
  TASKER_PROJECT_XML_FILENAME,
  compileDispatcherJs,
  compileProjectFiles,
  profileTaskName,
  profileWiringHash,
  syncPrepareJs,
  taskerProjectXml,
} from "../src/compiler.js";
import { MENU_TASK_NAME } from "../src/menu.js";

const TEST_REPO = { owner: "acme", repo: "automations" } as const;

const fixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(
      path.join(__dirname, "fixtures", "tasker-exports", name),
    );
  });

const flashTask = (name: string) =>
  new Task({ name, actions: [Action.flash("hi")] });

// Plain fields, so tests can derive variants without spreading the class.
const clipboardFields = {
  name: "Clipboard History",
  triggers: [
    Trigger.clipboardChanged(),
    Trigger.appOpened("Bitwarden", {
      packageName: "com.x8bit.bitwarden",
      invert: true,
    }),
  ],
  enter: flashTask("Record"),
} as const;

const clipboardProfile = new Profile(clipboardFields);

const manualProfile = new Profile({
  name: "Manual",
  triggers: [Trigger.event("Display On")],
  enter: flashTask("M"),
});

/** The elements of `tag` (with content) in an XML string */
const elements = (xml: string, tag: string): Array<string> =>
  [...xml.matchAll(new RegExp(`<${tag}[ >][\\s\\S]*?</${tag}>`, "g"))].map(
    (match) => match[0],
  );

/** Text of every `<child>` inside an element, as a sorted "child=value" list */
const leaves = (element: string): Array<string> =>
  [...element.matchAll(/<(code|flags|label0|pkg0|nme)>([^<]*)<\//g)]
    .map((match) => `${match[1]}=${match[2]}`)
    .sort();

/** The <Profile>/<Task> element whose <id> is `id` */
const byId = (xml: string, tag: string, id: number): string =>
  elements(xml, tag).find((element) => element.includes(`<id>${id}</id>`))!;

describe("profile wiring in the project XML", () => {
  it.effect(
    "matches the real Tasker export for the clipboard profile's contexts",
    () =>
      Effect.gen(function* () {
        const xml = taskerProjectXml({
          repo: TEST_REPO,
          profiles: [clipboardProfile],
        });
        const real = yield* fixture("clipboard-history.prf.xml");
        const profile = byId(xml, "Profile", 10);
        expect(profile).toContain("<nme>Clipboard History</nme>");
        const event = elements(profile, "Event")[0]!;
        const realEvent = elements(real, "Event")[0]!;
        expect(leaves(event)).toEqual(leaves(realEvent));
        expect(event).toContain(`<code>${CLIPBOARD_CHANGED_EVENT_CODE}</code>`);
        expect(event).toContain('<Int sr="arg1" val="1"/>');
        expect(realEvent).toContain('<Int sr="arg1" val="1"/>');
        // The real export also carries the activity class (cls0); the package
        // alone identifies the app.
        expect(leaves(elements(profile, "App")[0]!)).toEqual(
          leaves(elements(real, "App")[0]!),
        );
        expect(xml).toContain("<pids>4,10</pids>");
      }).pipe(Effect.provide(NodeContext.layer)),
  );

  it("puts the event first and wires named dispatcher stub tasks", () => {
    const profile = new Profile({
      name: "P",
      triggers: [
        Trigger.appOpened("A", { packageName: "com.a" }),
        Trigger.clipboardChanged({ ignoreSetByTasker: false }),
      ],
      enter: flashTask("In"),
      exit: flashTask("Out"),
    });
    const xml = taskerProjectXml({
      repo: TEST_REPO,
      jsDir: "/x/",
      profiles: [manualProfile, clipboardProfile, profile],
    });
    // Manual is left out; the others get ids 10 and 13 (+ task ids).
    expect(xml).toContain("<pids>4,10,13</pids>");
    expect(xml).not.toContain("<nme>Manual</nme>");
    const wired = byId(xml, "Profile", 13);
    expect(wired.indexOf('<Event sr="con0"')).toBeGreaterThan(0);
    expect(wired).toContain('<App sr="con1" ve="2">');
    expect(wired).toContain('<Int sr="arg1" val="0"/>');
    expect(wired).not.toContain("<flags>2</flags>");
    expect(wired).toContain("<mid0>14</mid0>");
    expect(wired).toContain("<mid1>15</mid1>");
    expect(byId(xml, "Profile", 10)).toContain("<mid0>11</mid0>");
    expect(byId(xml, "Profile", 10)).not.toContain("<mid1>");

    // Stub tasks: named (Tasker drops anonymous tasks on import), project
    // members, eval the dispatcher.
    const hash = profileWiringHash([manualProfile, clipboardProfile, profile]);
    expect(xml).toContain("<tids>1,2,3,5,6,11,14,15</tids>");
    for (const [id, name] of [
      [11, "TE Clipboard History (enter)"],
      [14, "TE P (enter)"],
      [15, "TE P (exit)"],
    ] as const) {
      const task = byId(xml, "Task", id);
      expect(task).toContain(`<nme>${name}</nme>`);
      expect(task).toContain("<code>129</code>");
      expect(task).toContain("/x/");
      expect(task).toContain(
        `setGlobal(&quot;TE_WIRING&quot;, &quot;${hash}&quot;);`,
      );
      expect(task).toContain(
        "eval(readFile(dir + &quot;dispatcher.js&quot;));",
      );
      expect(task).toContain('<Int sr="arg2" val="1"/>');
      expect(task).toContain('<Int sr="arg3" val="600"/>');
      // Run Both Together, so quick repeated triggers are not dropped.
      expect(task).toContain("<rty>2</rty>");
    }
    expect(byId(xml, "Task", 1)).not.toContain("<rty>");
    expect(byId(xml, "Task", 12)).toBeUndefined();
    expect(profileTaskName(profile, "exit")).toBe("TE P (exit)");
  });

  it("rejects duplicate task or profile names in the XML", () => {
    expect(() =>
      taskerProjectXml({
        repo: TEST_REPO,
        profiles: [clipboardProfile, clipboardProfile],
      }),
    ).toThrow(
      'tasker-effect.prj.xml: task name "TE Clipboard History (enter)" is used twice; profile name "Clipboard History" is used twice',
    );
    const syncClash = new Profile({ ...clipboardFields, name: "TE Sync" });
    expect(() =>
      compileProjectFiles(new Project({ name: "P", profiles: [syncClash] }), {
        repo: TEST_REPO,
      }),
    ).toThrow('profile name "TE Sync" is used twice');
  });

  it("leaves out profiles whose triggers have no known XML form", () => {
    for (const triggers of [
      [Trigger.event("Display On")],
      [Trigger.appOpened("No Package")],
      [Trigger.clipboardChanged(), Trigger.clipboardChanged()],
    ] as const) {
      const profile = new Profile({
        name: "Unwired",
        triggers: [...triggers] as never,
        enter: flashTask("In"),
      });
      const xml = taskerProjectXml({ repo: TEST_REPO, profiles: [profile] });
      expect(xml).not.toContain("Unwired");
      expect(xml).toContain("<pids>4</pids>");
    }
  });
});

describe("profileWiringHash", () => {
  it("is stable and changes only when the wiring changes", () => {
    const hash = profileWiringHash([clipboardProfile, manualProfile]);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    // Same wiring: equal, even with a different enter task or an unwired
    // profile added or removed.
    expect(
      profileWiringHash([
        new Profile({ ...clipboardFields, enter: flashTask("Other") }),
      ]),
    ).toBe(hash);
    for (const changed of [
      new Profile({
        ...clipboardFields,
        triggers: [Trigger.clipboardChanged()],
      }),
      new Profile({ ...clipboardFields, name: "Renamed" }),
      new Profile({ ...clipboardFields, exit: flashTask("Out") }),
    ]) {
      expect(profileWiringHash([changed])).not.toBe(hash);
    }
    expect(profileWiringHash([])).not.toBe(hash);
  });

  it("is stamped by TE Sync and checked (warn-only) by the dispatcher", () => {
    const project = new Project({ name: "P", profiles: [clipboardProfile] });
    const hash = profileWiringHash(project.profiles);
    expect(syncPrepareJs(undefined, hash)).toContain(
      `setGlobal("TE_WIRING", "${hash}");`,
    );
    expect(syncPrepareJs()).not.toContain("TE_WIRING");
    const xml = taskerProjectXml({
      repo: TEST_REPO,
      profiles: project.profiles,
    });
    expect(elements(xml, "Task")[1]).toContain(
      `setGlobal(&quot;TE_WIRING&quot;, &quot;${hash}&quot;);`,
    );
    const dispatcher = compileDispatcherJs(project);
    expect(dispatcher).toContain(`if (global("TE_WIRING") !== "${hash}") {`);
    expect(dispatcher).toContain(
      `profile triggers changed - delete the Tasker Effect project (Delete Contents) and re-import ${TASKER_PROJECT_XML_FILENAME}`,
    );
  });
});

describe("TE Menu task", () => {
  it.effect(
    "matches the Perform Task layout that imported fine on a device",
    () =>
      Effect.gen(function* () {
        const xml = taskerProjectXml({ repo: TEST_REPO });
        const task = byId(xml, "Task", 6);
        expect(task).toContain(`<nme>${MENU_TASK_NAME}</nme>`);
        const real = (yield* fixture(
          "show-clipboard-history.tsk.xml",
        )).replaceAll("Show Clipboard History", MENU_TASK_NAME);
        const strip = (s: string) =>
          elements(s, "Action")[0]!.replace(/\s+/g, "");
        expect(strip(task)).toBe(strip(real));
        expect(task).toContain(
          `<Str sr="arg0" ve="3">${DISPATCH_TASK_NAME}</Str>`,
        );
      }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("TE Sync task", () => {
  it.effect(
    "matches the HTTP Request + UnZip layout of a real download-and-unzip export",
    () =>
      Effect.gen(function* () {
        const xml = taskerProjectXml({ repo: TEST_REPO });
        const task = byId(xml, "Task", 2);
        const real = yield* fixture("http-download-unzip.tsk.xml");
        const actions = elements(task, "Action");
        const realActions = elements(real, "Action");
        // Compare the layout, ignoring whitespace, action numbers and the
        // values we set differently (URL and paths).
        const layout = (action: string) =>
          action
            .replace(/\s+/g, "")
            .replace(/sr="act\d+"/, "")
            .replace(/(<Strsr="arg[027]"ve="3">)[^<]*(<\/Str>)/g, "$1$2");
        expect(layout(actions[1]!)).toBe(layout(realActions[0]!));
        // Real: If %http_response_code = 200 (a separate action), then UnZip.
        // Ours: the same condition attached to the UnZip action itself,
        // placed after the arguments like the real action-level condition
        // on the Stop action (realActions[3]).
        const condition = elements(realActions[1]!, "ConditionList")[0]!;
        expect(layout(actions[2]!)).toBe(
          layout(realActions[2]!.replace("</Action>", `${condition}</Action>`)),
        );
        const stop = realActions[3]!;
        expect(stop.indexOf("<ConditionList")).toBeGreaterThan(
          stop.indexOf('sr="arg1"'),
        );
      }).pipe(Effect.provide(NodeContext.layer)),
  );
});

describe("compileProjectFiles profile wiring", () => {
  const project = new Project({
    name: "P",
    profiles: [clipboardProfile, manualProfile],
    tasks: [flashTask("Show It")],
  });
  const files = compileProjectFiles(project, { repo: TEST_REPO });
  const names = files.map((file) => file.filename);

  it("emits a single XML holding the wirable profiles", () => {
    expect(names.filter((name) => name.endsWith(".xml"))).toEqual([
      TASKER_PROJECT_XML_FILENAME,
    ]);
    const xml = files.find(
      (file) => file.filename === TASKER_PROJECT_XML_FILENAME,
    )!.content;
    expect(xml).toContain("<nme>Clipboard History</nme>");
    expect(xml).not.toContain("Manual");
    expect(xml).not.toContain("Show It");
    const readme = files.find((file) => file.filename === "README.md")!.content;
    expect(readme).toContain(
      `Wired in \`${TASKER_PROJECT_XML_FILENAME}\` (nothing to set up). Triggers:`,
    );
    expect(readme).toContain("Triggers to configure in the Tasker UI:");
    expect(readme).toContain(
      `Bind \`${MENU_TASK_NAME}\` to a gesture or shortcut`,
    );
  });
});
