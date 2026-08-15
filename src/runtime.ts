/**
 * @module runtime
 * @description Helpers for running Effect programs inside Tasker's
 * JavaScript environment.
 *
 * Use this when writing tasks directly against the Tasker service (rather
 * than the declarative DSL) and bundling them to a single JS file:
 *
 * ```typescript
 * import { Effect } from "effect";
 * import { Tasker, runInTasker } from "tasker-effect";
 *
 * const program = Effect.gen(function* () {
 *   const tasker = yield* Tasker;
 *   const battery = yield* tasker.global("BATT");
 *   yield* tasker.flash(`Battery at ${battery}%`);
 * });
 *
 * void runInTasker(program);
 * ```
 */

import { Cause, Effect } from "effect";
import { Tasker, raw } from "./tasker-api.js";

const tryFlash = (message: string): void => {
  try {
    raw.flash(message);
  } catch {
    // Off-device (no Tasker globals): nothing sensible to do with the toast.
  }
};

/**
 * Run an Effect program with the live Tasker service provided.
 *
 * Failures are flashed as a toast so they are visible on-device, then
 * rethrown so the returned promise rejects. When `exitWhenDone` is set the
 * script calls Tasker's exit() afterwards — required when the JavaScript
 * action has Auto Exit disabled (i.e. the program does asynchronous work).
 */
export const runInTasker = <A, E>(
  program: Effect.Effect<A, E, Tasker>,
  options?: { readonly exitWhenDone?: boolean }
): Promise<A> =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(Tasker.Default),
      Effect.tapErrorCause((cause) =>
        Effect.sync(() => tryFlash(`tasker-effect: ${Cause.pretty(cause)}`))
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (options?.exitWhenDone === true) {
            try {
              raw.exit();
            } catch {
              // Off-device: exit() does not exist.
            }
          }
        })
      )
    )
  );
