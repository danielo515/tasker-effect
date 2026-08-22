import { describe, expect, it } from "@effect/vitest";
import { compileProfileFiles } from "../src/compiler.js";
import {
  headphonesIn,
  videoRotation,
  readingMode,
} from "../tasks/popular/media.js";
import { batteryFullAlert, chargingDock } from "../tasks/popular/power.js";
import { expectValidJs } from "./support/valid-js.js";

const contentsByFilename = (
  files: ReadonlyArray<{ filename: string; content: string }>
) => new Map(files.map((f) => [f.filename, f.content]));

describe("popular media profiles", () => {
  it("Headphones In compiles enter/exit with volume, launch and pause", () => {
    const files = compileProfileFiles(headphonesIn);
    expect(files.map((f) => f.filename)).toEqual([
      "headphones-in.enter.js",
      "headphones-in.exit.js",
    ]);

    const byName = contentsByFilename(files);
    const enter = byName.get("headphones-in.enter.js")!;
    expect(enter).toContain("mediaVol(9");
    expect(enter).toContain('flash("Headphones connected — opening player");');
    expect(enter).toContain('loadApp("Spotify"');

    const exit = byName.get("headphones-in.exit.js")!;
    expect(exit).toContain('mediaControl("pause");');

    for (const file of files) expectValidJs(file.content);
  });

  it("Video Rotation toggles auto-rotate on enter/exit", () => {
    const files = compileProfileFiles(videoRotation);
    expect(files.map((f) => f.filename)).toEqual([
      "video-rotation.enter.js",
      "video-rotation.exit.js",
    ]);

    const byName = contentsByFilename(files);
    expect(byName.get("video-rotation.enter.js")).toContain(
      "displayAutoRotate(true);"
    );
    expect(byName.get("video-rotation.exit.js")).toContain(
      "displayAutoRotate(false);"
    );

    for (const file of files) expectValidJs(file.content);
  });

  it("Reading Mode extends the timeout and locks brightness", () => {
    const files = compileProfileFiles(readingMode);
    expect(files.map((f) => f.filename)).toEqual([
      "reading-mode.enter.js",
      "reading-mode.exit.js",
    ]);

    const byName = contentsByFilename(files);
    const enter = byName.get("reading-mode.enter.js")!;
    expect(enter).toContain("displayTimeout(0, 10, 0);");
    expect(enter).toContain("displayAutoBright(false);");
    expect(enter).toContain('flash("Reading mode: screen stays on");');

    const exit = byName.get("reading-mode.exit.js")!;
    expect(exit).toContain("displayTimeout(0, 0, 30);");
    expect(exit).toContain("displayAutoBright(true);");

    for (const file of files) expectValidJs(file.content);
  });
});

describe("popular power profiles", () => {
  it("Battery Full Alert has an enter file only, with vibrate/say/flash", () => {
    const files = compileProfileFiles(batteryFullAlert);
    expect(files.map((f) => f.filename)).toEqual([
      "battery-full-alert.enter.js",
    ]);

    const enter = files[0]!.content;
    expect(enter).toContain('vibratePattern("0,200,100,200");');
    expect(enter).toContain('say("Battery full, unplug the charger"');
    expect(enter).toContain('flash("Battery full — unplug");');

    expectValidJs(enter);
  });

  it("Charging Dock keeps the screen on while on AC and restores on exit", () => {
    const files = compileProfileFiles(chargingDock);
    expect(files.map((f) => f.filename)).toEqual([
      "charging-dock.enter.js",
      "charging-dock.exit.js",
    ]);

    const byName = contentsByFilename(files);
    const enter = byName.get("charging-dock.enter.js")!;
    expect(enter).toContain('stayOn("ac");');
    expect(enter).toContain('flash("Screen will stay on while charging");');

    const exit = byName.get("charging-dock.exit.js")!;
    expect(exit).toContain('stayOn("never");');

    for (const file of files) expectValidJs(file.content);
  });
});
