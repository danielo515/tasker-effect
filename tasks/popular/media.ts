/**
 * Popular community Tasker profiles: media and display automation.
 *
 * Classic recipes from the Tasker community (headphone handling, video
 * rotation, reading mode) expressed with the declarative DSL. Compile with
 * `bun run compile` or `bunx tasker-effect compile`.
 */

import { Action, Trigger, Task, Profile } from "../../src/index.js";

/** Raise media volume and open the music player when headphones connect; pause on unplug */
export const headphonesIn = new Profile({
  name: "Headphones In",
  description:
    "When a headset is plugged in, raise media volume and open the music player " +
    "(the app label \"Spotify\" is user-adjustable — swap in your own player). " +
    "Pauses playback when the headset is removed.",
  triggers: [Trigger.headsetPlugged()],
  enter: new Task({
    name: "Headphones Connected",
    actions: [
      Action.setVolume("media", 9),
      Action.flash("Headphones connected — opening player"),
      Action.launchApp("Spotify"),
    ],
  }),
  exit: new Task({
    name: "Headphones Removed",
    actions: [Action.mediaControl("pause")],
  }),
});

/** Enable auto-rotation only while watching video */
export const videoRotation = new Profile({
  name: "Video Rotation",
  description: "Auto-rotate the display only while YouTube is in the foreground",
  triggers: [Trigger.appOpened("YouTube")],
  enter: new Task({
    name: "Rotation On",
    actions: [Action.setAutoRotate(true)],
  }),
  exit: new Task({
    name: "Rotation Off",
    actions: [Action.setAutoRotate(false)],
  }),
});

/** Keep the screen alive and steady while reading */
export const readingMode = new Profile({
  name: "Reading Mode",
  description:
    "While the Kindle app is open, extend the display timeout and lock brightness",
  triggers: [Trigger.appOpened("Kindle")],
  enter: new Task({
    name: "Reading On",
    actions: [
      Action.displayTimeout({ minutes: 10 }),
      Action.setAutoBrightness(false),
      Action.flash("Reading mode: screen stays on"),
    ],
  }),
  exit: new Task({
    name: "Reading Off",
    actions: [
      Action.displayTimeout({ seconds: 30 }),
      Action.setAutoBrightness(true),
    ],
  }),
});

/** All media/display profiles in this module */
export const mediaProfiles = [headphonesIn, videoRotation, readingMode] as const;
