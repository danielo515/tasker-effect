/**
 * Popular community profiles: quiet hours.
 *
 * Ports of two of the most common Tasker setups shared by the community —
 * an overnight "do not disturb" window and a calendar-driven meeting
 * silencer. Compile with `bun run compile` alongside the other automations.
 */

import { Action, Trigger, Task, Profile } from "../../src/index.js";

/** Silence the phone and cut radios overnight (22:30 → 06:30). */
export const nightMode = new Profile({
  name: "Night Mode",
  description: "Silence the phone and cut radios overnight",
  triggers: [Trigger.time({ hour: 22, minute: 30 }, { to: { hour: 6, minute: 30 } })],
  enter: new Task({
    name: "Night Mode On",
    actions: [
      Action.silentMode("on"),
      Action.setVolume("ringer", 0),
      Action.setVolume("notification", 0),
      Action.setWifi(false),
      Action.setAutoSync(false),
      Action.setGlobal("%NIGHT", "1"),
    ],
  }),
  exit: new Task({
    name: "Night Mode Off",
    actions: [
      Action.silentMode("off"),
      Action.setVolume("ringer", 5),
      Action.setVolume("notification", 5),
      Action.setWifi(true),
      Action.setAutoSync(true),
      Action.setGlobal("%NIGHT", "0"),
    ],
  }),
});

/** Vibrate-only while any busy calendar entry is active. */
export const meetingSilencer = new Profile({
  name: "Meeting Silencer",
  description: "Switch to vibrate during any busy calendar entry",
  triggers: [Trigger.calendarEntry()],
  enter: new Task({
    name: "Meeting Silence",
    actions: [
      Action.silentMode("vibrate"),
      Action.setVolume("notification", 0),
      Action.flash("In a meeting — silenced"),
    ],
  }),
  exit: new Task({
    name: "Meeting Unsilence",
    actions: [Action.silentMode("off"), Action.setVolume("notification", 5)],
  }),
});

/** All quiet-hours profiles in this file. */
export const quietProfiles: ReadonlyArray<Profile> = [nightMode, meetingSilencer];
