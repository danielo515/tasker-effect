/**
 * Basic tasker-effect walkthrough: define a task with the DSL, compile it
 * to Tasker-executable JavaScript and print the result.
 *
 * Run with: bun run examples/basic.ts
 */

import { Effect } from "effect";
import {
  Action,
  Trigger,
  Task,
  Profile,
  cond,
  compileTaskToJs,
  compileProfileFiles,
  describeTrigger,
} from "../src/index.js";

// A task is a validated sequence of actions.
const eveningWindDown = new Task({
  name: "Evening Wind Down",
  description: "Quiet the phone and dim expectations",
  actions: [
    Action.flash("Winding down for the night"),
    Action.setVolume("ringer", 1),
    Action.silentMode("vibrate"),
    Action.when(
      cond("%LOCATION", "eq", "home"),
      [Action.say("Good night"), Action.setWifi(true)],
      [Action.flash("Not home yet — leaving radios on")]
    ),
    Action.setGlobal("%DAY_PHASE", "night"),
  ],
});

// Profiles attach trigger metadata (configured once in the Tasker UI).
const nightly = new Profile({
  name: "Nightly",
  triggers: [Trigger.time({ hour: 22, minute: 30 })],
  enter: eveningWindDown,
});

const program = Effect.gen(function* () {
  yield* Effect.log("Compiled JavaScript for the task:");
  yield* Effect.sync(() => process.stdout.write(compileTaskToJs(eveningWindDown) + "\n"));

  yield* Effect.log("Files a profile compiles to:");
  for (const file of compileProfileFiles(nightly)) {
    yield* Effect.log("file", { filename: file.filename, bytes: file.content.length });
  }

  yield* Effect.log("Trigger setup in the Tasker UI:");
  for (const trigger of nightly.triggers) {
    yield* Effect.log(describeTrigger(trigger));
  }
});

void Effect.runPromise(program);
