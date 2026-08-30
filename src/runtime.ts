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
import { Tasker } from "./tasker-api.js";

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
      Effect.tapErrorCause((cause) =>
        Tasker.use((t) => t.flash(`tasker-effect: ${Cause.pretty(cause)}`)).pipe(
          Effect.ignore
        )
      ),
      Effect.ensuring(
        options?.exitWhenDone === true
          ? Tasker.use((t) => t.exit()).pipe(Effect.ignore)
          : Effect.void
      ),
      Effect.provide(Tasker.Default)
    )
  );
