/**
 * Basic example of tasker-effect usage
 *
 * This example shows how to:
 * - Define tasks and profiles
 * - Use various triggers and actions
 * - Compile to Tasker XML format
 */

import { Effect } from "effect";
import {
  // Profile/Task builders
  profile,
  task,
  project,
  // Trigger builders
  time,
  wifi,
  bluetooth,
  battery,
  app,
  variable,
  // Action builders
  flash,
  setVar,
  performTask,
  wait,
  javascriptlet,
  shell,
  http,
  // Compiler
  compileProjectToXml,
  compileProfileToXml,
  // Types
  type Profile,
  type Task,
} from "../src/index.js";

// =============================================================================
// Example 1: Simple Task
// =============================================================================

const greetTask = task("Greet User", [
  flash("Hello! Welcome to Tasker Effect!"),
  setVar("%GREETED", "true"),
]);

// =============================================================================
// Example 2: Task with Variables and Math
// =============================================================================

const counterTask = task("Increment Counter", [
  // Initialize if not set
  setVar("%COUNTER", "0"),
  // Increment using math
  setVar("%COUNTER", "%COUNTER + 1", { doMaths: true }),
  // Display result
  flash("Counter: %COUNTER"),
]);

// =============================================================================
// Example 3: Task with JavaScript
// =============================================================================

const weatherTask = task("Check Weather", [
  // Fetch weather data
  http("GET", "https://api.open-meteo.com/v1/forecast?latitude=40.41&longitude=-3.70&current_weather=true", {
    outputVariable: "%http_data",
    timeout: 30,
  }),
  // Parse the response
  javascriptlet(`
    try {
      var data = JSON.parse(http_data);
      var temp = data.current_weather.temperature;
      var code = data.current_weather.weathercode;
      
      setLocal('temp', temp + '°C');
      setLocal('weather_ok', 'true');
    } catch (e) {
      setLocal('weather_ok', 'false');
      setLocal('temp', 'N/A');
    }
  `),
  // Show result
  flash("Temperature: %temp"),
]);

// =============================================================================
// Example 4: Time-based Profile
// =============================================================================

const morningProfile = profile(
  "Morning Routine",
  [
    time(
      { hour: 7, minute: 0 },
      {
        to: { hour: 8, minute: 30 },
        days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
      }
    ),
  ],
  task("Morning Entry", [
    flash("Good morning! ☀️"),
    setVar("%DAY_PHASE", "morning"),
    // Enable Bluetooth for car connection
    shell("svc bluetooth enable"),
    wait({ seconds: 2 }),
    performTask("Check Weather"),
  ]),
  {
    exit: task("Morning Exit", [
      flash("Morning routine ended"),
      setVar("%DAY_PHASE", "day"),
    ]),
    description: "Activates on weekday mornings",
  }
);

// =============================================================================
// Example 5: WiFi-based Profile
// =============================================================================

const homeWifiProfile = profile(
  "Home Network",
  [wifi({ ssid: "MyHomeWiFi", connected: true })],
  task("Home Arrived", [
    flash("Welcome home! 🏠"),
    setVar("%LOCATION", "home"),
    // Turn on smart home stuff via HTTP
    http("POST", "http://192.168.1.100/api/presence", {
      body: JSON.stringify({ home: true }),
      headers: { "Content-Type": "application/json" },
    }),
  ]),
  {
    exit: task("Home Left", [
      flash("Goodbye! Have a safe trip! 👋"),
      setVar("%LOCATION", "away"),
      http("POST", "http://192.168.1.100/api/presence", {
        body: JSON.stringify({ home: false }),
        headers: { "Content-Type": "application/json" },
      }),
    ]),
  }
);

// =============================================================================
// Example 6: Battery-based Profile
// =============================================================================

const lowBatteryProfile = profile(
  "Low Battery Saver",
  [battery(0, 15)],
  task("Enable Power Save", [
    flash("Battery low! Enabling power saving... 🔋"),
    setVar("%POWER_MODE", "saver"),
    // Reduce screen brightness
    shell("settings put system screen_brightness 50"),
    // Disable sync
    shell("content update --uri content://settings/global --where 'name=\"auto_sync\"' --bind value:s:0"),
  ]),
  {
    exit: task("Disable Power Save", [
      flash("Battery recovered! ✨"),
      setVar("%POWER_MODE", "normal"),
      shell("settings put system screen_brightness 128"),
    ]),
    description: "Enables battery saver when battery < 15%",
  }
);

// =============================================================================
// Example 7: App-based Profile
// =============================================================================

const spotifyProfile = profile(
  "Spotify Playing",
  [app("com.spotify.music")],
  task("Music Mode", [
    flash("🎵 Music mode activated"),
    setVar("%MEDIA_APP", "spotify"),
    // Set media volume
    shell("media volume --set 10 --stream 3"),
  ]),
  {
    exit: task("Music Mode Exit", [
      setVar("%MEDIA_APP", "none"),
    ]),
  }
);

// =============================================================================
// Example 8: Variable-based Profile
// =============================================================================

const debugModeProfile = profile(
  "Debug Mode",
  [variable("%DEBUG", "equals", "true")],
  task("Enable Debug", [
    flash("Debug mode ON 🐛"),
    setVar("%LOG_LEVEL", "verbose"),
  ]),
  {
    exit: task("Disable Debug", [
      flash("Debug mode OFF"),
      setVar("%LOG_LEVEL", "normal"),
    ]),
  }
);

// =============================================================================
// Example 9: Bluetooth-based Profile
// =============================================================================

const carProfile = profile(
  "Car Mode",
  [bluetooth({ name: "Car Stereo", connected: true })],
  task("Car Connected", [
    flash("🚗 Car mode activated"),
    setVar("%IN_CAR", "true"),
    // Launch navigation app
    javascriptlet(`loadApp('com.google.android.apps.maps');`),
    // Read notifications aloud
    performTask("Enable Notification Reader"),
  ]),
  {
    exit: task("Car Disconnected", [
      flash("Car mode deactivated"),
      setVar("%IN_CAR", "false"),
    ]),
  }
);

// =============================================================================
// Combine into a Project
// =============================================================================

const myAutomations = project("My Automations", {
  profiles: [
    morningProfile,
    homeWifiProfile,
    lowBatteryProfile,
    spotifyProfile,
    debugModeProfile,
    carProfile,
  ],
  tasks: [greetTask, counterTask, weatherTask],
  description: "Personal automation collection built with tasker-effect",
});

// =============================================================================
// Compile and Output
// =============================================================================

async function main() {
  console.log("🔧 Compiling Tasker project...\n");

  // Compile the entire project
  const projectXml = await Effect.runPromise(compileProjectToXml(myAutomations));

  console.log("📄 Project XML:");
  console.log("================\n");
  console.log(projectXml);
  console.log("\n================\n");

  // Compile a single profile for demonstration
  console.log("📝 Single profile (Morning Routine):");
  console.log("================\n");
  const profileOutputs = await Effect.runPromise(compileProfileToXml(morningProfile));
  profileOutputs.forEach((output) => {
    console.log(`File: ${output.filename}`);
    console.log(`Type: ${output.type}`);
    console.log("---");
  });

  console.log("\n✅ Done!");
}

main().catch(console.error);
