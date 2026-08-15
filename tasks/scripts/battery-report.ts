/**
 * Effect-based script bundled to a single JS file for Tasker.
 *
 * Unlike the declarative DSL in ../automations.ts, scripts in this
 * directory run the Effect runtime on-device: `bun run compile` bundles
 * each of them (plus the effect dependency) into dist-tasker/<name>.js.
 *
 * In Tasker, create a task with a JavaScript action pointing at the bundled
 * file and disable Auto Exit (the script calls exit() itself when done).
 */

import { Effect } from "effect";
import { Tasker } from "../../src/tasker-api.js";
import { runInTasker } from "../../src/runtime.js";

const program = Effect.gen(function* () {
  const tasker = yield* Tasker;

  const battery = yield* tasker.global("BATT");
  const level = Number.parseInt(battery, 10);

  if (Number.isNaN(level)) {
    yield* tasker.flash("Battery level unknown");
    return;
  }

  yield* tasker.flash(`Battery at ${level}%`);
  if (level < 20) {
    yield* tasker.say(`Battery low, ${level} percent left`, undefined, undefined, "media", 5, 5);
    yield* tasker.setGlobal("POWER_MODE", "saver");
  }
});

void runInTasker(program, { exitWhenDone: true });
