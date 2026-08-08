#!/usr/bin/env bun
/**
 * Profile compilation script
 *
 * This script compiles all profile definitions from examples/ to
 * Tasker-importable XML files in compiled-profiles/
 */

import { Effect } from "effect";
import { writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import {
  profile,
  task,
  project,
  time,
  wifi,
  battery,
  flash,
  setVar,
  performTask,
  javascriptlet,
  http,
  shell,
  compileProjectToXml,
  compileProfileToXml,
  compileTaskToXml,
  type Profile,
  type Task,
  type Project,
} from "../src/index.js";

const OUTPUT_DIR = "compiled-profiles";

// =============================================================================
// Example Profiles
// =============================================================================

/** Morning routine profile */
const morningRoutine = profile(
  "Morning Routine",
  [
    time(
      { hour: 7, minute: 0 },
      {
        to: { hour: 9, minute: 0 },
        days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
      }
    ),
  ],
  task("Morning Actions", [
    flash("Good morning! Starting your day..."),
    setVar("%DAYTIME", "morning"),
    setVar("%BRIGHTNESS", "80", { doMaths: true }),
    javascriptlet(`
      // Calculate time until work
      var now = new Date();
      var workStart = new Date();
      workStart.setHours(9, 0, 0, 0);
      var diff = workStart - now;
      var minutes = Math.floor(diff / 60000);
      setGlobal('WORK_COUNTDOWN', minutes + ' minutes');
    `),
    performTask("Enable Work Mode"),
  ]),
  {
    exit: task("Morning Exit", [
      flash("Morning routine ended"),
      setVar("%DAYTIME", "day"),
    ]),
    description: "Activates weekday mornings from 7-9 AM",
  }
);

/** Low battery profile */
const lowBatteryProfile = profile(
  "Low Battery Saver",
  [battery(0, 20)],
  task("Enable Battery Saver", [
    flash("Battery low! Enabling power saving mode..."),
    setVar("%POWER_MODE", "saver"),
    shell("settings put global low_power 1", { root: true }),
  ]),
  {
    exit: task("Disable Battery Saver", [
      flash("Battery recovered. Disabling power saving."),
      setVar("%POWER_MODE", "normal"),
      shell("settings put global low_power 0", { root: true }),
    ]),
    description: "Enables battery saver when battery drops below 20%",
  }
);

/** Home WiFi profile */
const homeWifiProfile = profile(
  "Home WiFi",
  [wifi({ ssid: "MyHomeNetwork", connected: true })],
  task("Home Mode", [
    flash("Welcome home!"),
    setVar("%LOCATION", "home"),
    performTask("Sync Home Devices"),
  ]),
  {
    exit: task("Leave Home", [
      flash("Goodbye! Have a nice day."),
      setVar("%LOCATION", "away"),
    ]),
    description: "Activates when connected to home WiFi",
  }
);

/** API fetch task */
const apiFetchTask = task("Fetch Weather", [
  http("GET", "https://api.example.com/weather", {
    headers: { Authorization: "Bearer %API_KEY" },
    outputVariable: "%weather_data",
    timeout: 30,
  }),
  javascriptlet(`
    var data = JSON.parse(weather_data);
    setLocal('temperature', data.temp);
    setLocal('condition', data.condition);
  `),
  flash("Weather: %temperature°C, %condition"),
]);

/** Combined project */
const myAutomationsProject = project("My Automations", {
  profiles: [morningRoutine, lowBatteryProfile, homeWifiProfile],
  tasks: [apiFetchTask],
  description: "My personal Tasker automations",
});

// =============================================================================
// Compilation
// =============================================================================

async function main() {
  console.log("🔧 Compiling Tasker profiles...\n");

  // Ensure output directory exists
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Compile individual profiles
  const profiles = [morningRoutine, lowBatteryProfile, homeWifiProfile];

  for (const prof of profiles) {
    console.log(`📝 Compiling profile: ${prof.name}`);
    const outputs = await Effect.runPromise(compileProfileToXml(prof));
    for (const output of outputs) {
      const path = join(OUTPUT_DIR, output.filename);
      writeFileSync(path, output.content);
      console.log(`   ✓ ${output.filename}`);
    }
  }

  // Compile individual tasks
  const tasks = [apiFetchTask];

  for (const tsk of tasks) {
    console.log(`📝 Compiling task: ${tsk.name}`);
    const xml = await Effect.runPromise(compileTaskToXml(tsk));
    const path = join(OUTPUT_DIR, `${tsk.name}.tsk.xml`);
    writeFileSync(path, xml);
    console.log(`   ✓ ${tsk.name}.tsk.xml`);
  }

  // Compile project
  console.log(`📦 Compiling project: ${myAutomationsProject.name}`);
  const projectXml = await Effect.runPromise(
    compileProjectToXml(myAutomationsProject)
  );
  const projectPath = join(OUTPUT_DIR, `${myAutomationsProject.name}.prj.xml`);
  writeFileSync(projectPath, projectXml);
  console.log(`   ✓ ${myAutomationsProject.name}.prj.xml`);

  // Generate index
  const files = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".xml"));
  const indexContent = `# Compiled Tasker Profiles

Generated: ${new Date().toISOString()}

## Files

${files.map((f) => `- \`${f}\``).join("\n")}

## Import Instructions

1. Copy the XML files to your Android device
2. In Tasker:
   - For \`.tsk.xml\`: Long press TASKS tab → Import Task
   - For \`.prf.xml\`: Long press PROFILES tab → Import Profile  
   - For \`.prj.xml\`: Long press project bar → Import Project

## Profile Descriptions

${profiles.map((p) => `### ${p.name}\n${p.description || "No description"}`).join("\n\n")}
`;

  writeFileSync(join(OUTPUT_DIR, "README.md"), indexContent);

  console.log("\n✅ Compilation complete!");
  console.log(`📁 Output: ${OUTPUT_DIR}/`);
}

main().catch(console.error);
