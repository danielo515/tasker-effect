/**
 * Popular community Tasker profiles: power and charging automation.
 *
 * Classic recipes from the Tasker community (battery-full alert, charging
 * dock behavior) expressed with the declarative DSL. Compile with
 * `bun run compile` or `bunx tasker-effect compile`.
 */

import { Action, Trigger, Task, Profile } from "../../src/index.js";

/** Alert loudly when the battery reaches 100% while charging */
export const batteryFullAlert = new Profile({
  name: "Battery Full Alert",
  description:
    "Both triggers must hold: on external power AND battery at 100%. " +
    "Vibrates, speaks and flashes a reminder to unplug the charger.",
  triggers: [Trigger.power(), Trigger.batteryLevel(100, 100)],
  enter: new Task({
    name: "Battery Full Notify",
    actions: [
      Action.vibratePattern("0,200,100,200"),
      Action.say("Battery full, unplug the charger"),
      Action.flash("Battery full — unplug"),
    ],
  }),
});

/** Keep the display on while docked on AC power */
export const chargingDock = new Profile({
  name: "Charging Dock",
  description:
    "While on AC power, keep the screen on; restore normal behavior on unplug",
  triggers: [Trigger.power("ac")],
  enter: new Task({
    name: "Dock On",
    actions: [
      Action.stayOn("ac"),
      Action.flash("Screen will stay on while charging"),
    ],
  }),
  exit: new Task({
    name: "Dock Off",
    actions: [Action.stayOn("never")],
  }),
});

/** All power/charging profiles in this module */
export const powerProfiles = [batteryFullAlert, chargingDock] as const;
