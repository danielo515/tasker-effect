import { describe, expect, it } from "@effect/vitest";
import {
  compileProfileFiles,
  compileProjectFiles,
  describeTrigger,
} from "../src/compiler.js";
import { Project } from "../src/profile.js";
import { nightMode, meetingSilencer, quietProfiles } from "../tasks/popular/quiet.js";
import { drivingMode, drivingAutoReply, drivingProfiles } from "../tasks/popular/driving.js";
import { expectValidJs } from "./support/valid-js.js";

describe("popular quiet profiles", () => {
  it("Night Mode compiles enter/exit with silence + radio calls", () => {
    const files = compileProfileFiles(nightMode);
    expect(files.map((f) => f.filename)).toEqual([
      "night-mode.enter.js",
      "night-mode.exit.js",
    ]);

    const [enter, exit] = files;
    expect(enter?.content).toContain('silentMode("on");');
    expect(enter?.content).toContain("ringerVol(0, false, false);");
    expect(enter?.content).toContain("notificationVol(0, false, false);");
    expect(enter?.content).toContain("setWifi(false);");
    expect(enter?.content).toContain("setAutoSync(false);");
    expect(enter?.content).toContain('setGlobal("NIGHT", "1");');

    expect(exit?.content).toContain('silentMode("off");');
    expect(exit?.content).toContain("ringerVol(5, false, false);");
    expect(exit?.content).toContain("notificationVol(5, false, false);");
    expect(exit?.content).toContain("setWifi(true);");
    expect(exit?.content).toContain("setAutoSync(true);");
    expect(exit?.content).toContain('setGlobal("NIGHT", "0");');

    for (const file of files) expectValidJs(file.content);
  });

  it("Meeting Silencer compiles enter/exit with vibrate + flash", () => {
    const files = compileProfileFiles(meetingSilencer);
    expect(files.map((f) => f.filename)).toEqual([
      "meeting-silencer.enter.js",
      "meeting-silencer.exit.js",
    ]);

    const [enter, exit] = files;
    expect(enter?.content).toContain('silentMode("vibrate");');
    expect(enter?.content).toContain("notificationVol(0, false, false);");
    expect(enter?.content).toContain('flash("In a meeting — silenced");');

    expect(exit?.content).toContain('silentMode("off");');
    expect(exit?.content).toContain("notificationVol(5, false, false);");

    for (const file of files) expectValidJs(file.content);
  });
});

describe("popular driving profiles", () => {
  it("Driving Mode compiles enter/exit with car mode + %DRIVING flag", () => {
    const files = compileProfileFiles(drivingMode);
    expect(files.map((f) => f.filename)).toEqual([
      "driving-mode.enter.js",
      "driving-mode.exit.js",
    ]);

    const [enter, exit] = files;
    expect(enter?.content).toContain("carMode(true);");
    expect(enter?.content).toContain("mediaVol(12, false, false);");
    expect(enter?.content).toContain('setGlobal("DRIVING", "1");');
    expect(enter?.content).toContain('flash("Driving mode on");');

    expect(exit?.content).toContain("carMode(false);");
    expect(exit?.content).toContain('setGlobal("DRIVING", "0");');

    for (const file of files) expectValidJs(file.content);
  });

  it("Driving Auto Reply compiles an enter-only runtime SMS reply", () => {
    const files = compileProfileFiles(drivingAutoReply);
    expect(files.map((f) => f.filename)).toEqual(["driving-auto-reply.enter.js"]);

    const [enter] = files;
    expect(enter?.content).toContain('local("SMSRF")');
    expect(enter?.content).toContain('global("DRIVING") === "1"');
    expect(enter?.content).toContain("sendSMS(");
    expectValidJs(enter?.content ?? "");
  });
});

describe("popular profiles project README", () => {
  it("describeTrigger output for calendarEntry and receivedText appears", () => {
    const project = new Project({
      name: "Popular Profiles",
      profiles: [...quietProfiles, ...drivingProfiles],
    });
    const files = compileProjectFiles(project, {
      repo: { owner: "acme", repo: "automations" },
    });
    const readme = files.find((f) => f.filename === "README.md");
    expect(readme).toBeDefined();
    expect(readme?.content).toContain(
      describeTrigger(meetingSilencer.triggers[0])
    );
    expect(readme?.content).toContain(
      describeTrigger(drivingAutoReply.triggers[0])
    );
  });
});
