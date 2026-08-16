/**
 * Example automations compiled by CI into Tasker-executable JavaScript.
 *
 * Add your own profiles/tasks here (or in sibling files) and run
 * `bun run compile` to produce `dist-tasker/`.
 */

import {
  Action,
  Trigger,
  Task,
  Profile,
  Project,
  cond,
} from "../src/index.js";

/** Standalone task: fetch weather and warn conditionally */
const weatherCheck = new Task({
  name: "Weather Check",
  description: "Fetch current weather and warn when it is freezing",
  actions: [
    Action.http(
      "GET",
      "https://api.open-meteo.com/v1/forecast?latitude=40.41&longitude=-3.70&current_weather=true",
      { outputGlobal: "%WEATHER_JSON" }
    ),
    Action.js(
      [
        'var data = JSON.parse(global("WEATHER_JSON"));',
        'setGlobal("TEMPERATURE", String(data.current_weather.temperature));',
      ].join("\n")
    ),
    Action.when(
      cond("%TEMPERATURE", "lt", "0"),
      [Action.flash("Freezing outside: %TEMPERATURE °C"), Action.say("It is freezing outside")],
      [Action.flash("Current temperature: %TEMPERATURE °C")]
    ),
  ],
});

/** Weekday wake-up: greet, raise media volume, announce the day */
const morningRoutine = new Profile({
  name: "Morning Routine",
  description: "Weekday mornings from 07:00 to 09:00",
  triggers: [
    Trigger.time(
      { hour: 7, minute: 0 },
      {
        to: { hour: 9, minute: 0 },
        days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
      }
    ),
  ],
  enter: new Task({
    name: "Morning Enter",
    actions: [
      Action.flash("Good morning!"),
      Action.setVolume("media", 7),
      Action.say("Time to wake up"),
      Action.setGlobal("%DAY_PHASE", "morning"),
      // Typed task reference: passes the Task object, the compiler routes the
      // call through TE Dispatch and the linker verifies it at compile time.
      Action.performTask(weatherCheck),
    ],
  }),
  exit: new Task({
    name: "Morning Exit",
    actions: [Action.setGlobal("%DAY_PHASE", "day")],
  }),
});

/** Battery saver: react to low battery levels */
const lowBattery = new Profile({
  name: "Low Battery Saver",
  description: "Cut radios when the battery drops below 20%",
  triggers: [Trigger.batteryLevel(0, 20)],
  enter: new Task({
    name: "Battery Saver On",
    actions: [
      Action.flash("Battery low — saving power"),
      Action.setWifi(false),
      Action.setAutoSync(false),
      Action.setGlobal("%POWER_MODE", "saver"),
    ],
  }),
  exit: new Task({
    name: "Battery Saver Off",
    actions: [
      Action.setWifi(true),
      Action.setAutoSync(true),
      Action.setGlobal("%POWER_MODE", "normal"),
    ],
  }),
});

/** Presence detection via home Wi-Fi */
const homeWifi = new Profile({
  name: "Home WiFi",
  description: "Track presence based on the home network",
  triggers: [Trigger.wifiConnected("MyHomeNetwork")],
  enter: new Task({
    name: "Arrive Home",
    actions: [
      Action.flash("Welcome home!"),
      Action.setGlobal("%LOCATION", "home"),
      Action.setVolume("ringer", 5),
    ],
  }),
  exit: new Task({
    name: "Leave Home",
    actions: [
      Action.setGlobal("%LOCATION", "away"),
      Action.setVolume("ringer", 2),
    ],
  }),
});

export const automations = new Project({
  name: "tasker-effect automations",
  description: "Example automations managed as TypeScript",
  profiles: [morningRoutine, lowBattery, homeWifi],
  tasks: [weatherCheck],
});
