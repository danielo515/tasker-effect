/**
 * Popular community profiles: driving.
 *
 * Ports of two widely shared Tasker setups — a car-mode toggle keyed to the
 * car stereo's Bluetooth connection and an SMS auto-reply that only fires
 * while driving. Compile with `bun run compile` alongside the other
 * automations.
 */

import { Action, Trigger, Task, Profile } from "../../src/index.js";

/**
 * Turn on Android car mode while connected to the car stereo. The Bluetooth
 * device name ("Car") should match the user's car stereo BT name — edit it
 * to your own device before configuring the trigger in the Tasker UI.
 */
export const drivingMode = new Profile({
  name: "Driving Mode",
  description:
    'Car mode while connected to the car stereo over Bluetooth. The trigger device name ("Car") should match your car stereo\'s Bluetooth name.',
  triggers: [Trigger.bluetoothConnected("Car")],
  enter: new Task({
    name: "Driving On",
    actions: [
      Action.setCarMode(true),
      Action.setVolume("media", 12),
      Action.setGlobal("%DRIVING", "1"),
      Action.flash("Driving mode on"),
    ],
  }),
  exit: new Task({
    name: "Driving Off",
    actions: [Action.setCarMode(false), Action.setGlobal("%DRIVING", "0")],
  }),
});

/**
 * Auto-reply to incoming texts while %DRIVING is set. Raw JS is needed
 * because the DSL's SendSms takes a literal number; the sender is only known
 * at runtime (Tasker's %SMSRF event-local variable).
 */
export const drivingAutoReply = new Profile({
  name: "Driving Auto Reply",
  description: "Reply to incoming texts automatically while driving",
  triggers: [Trigger.receivedText()],
  enter: new Task({
    name: "Driving Reply",
    actions: [
      Action.js(
        [
          'var sender = local("SMSRF");',
          'if (global("DRIVING") === "1" && sender) {',
          '  sendSMS(sender, "I\'m driving right now — I\'ll get back to you soon.", false);',
          "}",
        ].join("\n")
      ),
    ],
  }),
});

/** All driving profiles in this file. */
export const drivingProfiles: ReadonlyArray<Profile> = [drivingMode, drivingAutoReply];
