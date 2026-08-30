/**
 * @module config
 * @description A Tasker-backed Effect `ConfigProvider` — the one way Effect
 * scripts read secrets (and any other configuration) on-device.
 *
 * Config keys map to Tasker **global** variables: path segments are joined
 * with `_` and uppercased (`Config.nested(Config.string("KEY"), "TE")` →
 * `%TE_KEY`). When a key has no value, the provider prompts the user by
 * performing the static `TE Config` task in its one-off mode (`%par1` =
 * global name, `%par2` = dialog label) and polls the global until the
 * answer arrives — which the dialog stores via `setGlobal`, so it is cached
 * for every later read. Unanswered prompts fail with an idiomatic
 * `ConfigError`, composing with `Config.withDefault` / `Config.option`.
 *
 * The prompt is performed at the *caller's* priority + 1 (read from Tasker's
 * built-in `%priority` local): Tasker only runs the actions of the
 * highest-priority alive task, so a fixed low priority would leave
 * `TE Config` queued frozen behind the very task that is polling for its
 * answer. Dismissing the dialog is detected via `taskRunning("TE Config")`
 * flipping true → false with the global still unset, so fallbacks
 * (`Config.withDefault` / `Config.option`) trigger promptly instead of
 * waiting out the full prompt timeout.
 *
 * Invariant: the JavaScript action hosting the program must have a timeout
 * **greater than** `promptTimeout` multiplied by the number of distinct
 * unset keys a run may prompt for (the generated `TE Dispatch` uses 600s vs
 * the 120s default) — each unset key prompts and polls in turn, so the
 * total time a run can spend prompting scales with how many keys are unset,
 * not just a single prompt's timeout — otherwise Tasker kills the script
 * before the provider can fail over.
 *
 * Prompt labels come from the {@link Secret} declarations passed to the
 * layer; unknown keys prompt with the bare global name.
 */

import {
  Cause,
  Config,
  ConfigError,
  ConfigProvider,
  ConfigProviderPathPatch,
  Deferred,
  Duration,
  Effect,
  Exit,
  HashSet,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect";
import { CONFIG_TASK_NAME } from "./compiler.js";
import type { Secret } from "./profile.js";
import { Tasker, type TaskerApiError, type TaskerShape } from "./tasker-api.js";

/** The slice of the Tasker API the provider needs (test with makeTestTasker) */
export type TaskerConfigApi = Pick<
  TaskerShape,
  "global" | "local" | "performTask" | "taskRunning"
>;

/** Options for the Tasker config provider */
export interface TaskerConfigOptions {
  /** Declared secrets, used for human-readable prompt labels */
  readonly secrets?: ReadonlyArray<Secret>;
  /**
   * How long to wait for a prompt answer. Default: 120s. The timeout of the
   * JavaScript action hosting the program (the generated `TE Dispatch` uses
   * 600s) must exceed this multiplied by the number of distinct keys a run
   * may prompt for, or Tasker kills the script before the provider can fail
   * over to `Config.withDefault` / `Config.option`.
   */
  readonly promptTimeout?: Duration.DurationInput;
  /** How often to poll the global while waiting. Default: 1s */
  readonly pollInterval?: Duration.DurationInput;
}

/** Prompt task priority when the caller's %priority cannot be read */
const FALLBACK_PROMPT_PRIORITY = 5;

/** A non-negative integer priority, decoded strictly from Tasker's %priority text. */
const Priority = Schema.compose(Schema.NonEmptyString, Schema.NumberFromString).pipe(
  Schema.int(),
  Schema.nonNegative()
);

/** Parse Tasker's %priority local; undefined for unset/garbage values. */
const parsePriority = (value: string | undefined): number | undefined =>
  Schema.decodeUnknownOption(Priority)(value).pipe(Option.getOrUndefined);

const globalNameOf = (path: ReadonlyArray<string>): string =>
  path.join("_").toUpperCase();

const sourceUnavailable = (
  path: ReadonlyArray<string>,
  name: string,
  error: TaskerApiError
): ConfigError.ConfigError =>
  ConfigError.SourceUnavailable(
    [...path],
    `Tasker is not available for %${name}: ${error.message}`,
    Cause.fail(error)
  );

/**
 * Build the provider from an explicit Tasker API — unit-testable with
 * `makeTestTasker`. Use {@link taskerConfigLayer} in programs.
 */
export const makeTaskerConfigProvider = (
  tasker: TaskerConfigApi,
  options?: TaskerConfigOptions
): Effect.Effect<ConfigProvider.ConfigProvider> =>
  Effect.gen(function* () {
    const labels = new Map(
      (options?.secrets ?? []).map((secret) => [secret.name, secret.description])
    );
    const pollInterval = Duration.decode(options?.pollInterval ?? Duration.seconds(1));
    const timeout = Duration.decode(options?.promptTimeout ?? Duration.seconds(120));
    const inFlight = yield* Ref.make(
      new Map<string, Deferred.Deferred<string, ConfigError.ConfigError>>()
    );

    const readGlobal = (
      path: ReadonlyArray<string>,
      name: string
    ): Effect.Effect<string | undefined, ConfigError.ConfigError> =>
      tasker.global(name).pipe(
        Effect.mapError((error) => sourceUnavailable(path, name, error)),
        // Tasker returns undefined for unset globals; treat empty as unset
        // either way.
        Effect.map((value) => (value === undefined || value === "" ? undefined : value))
      );

    /**
     * Prompt once per key: concurrent readers await the same Deferred. The
     * TE Config task is performed at the caller's priority + 1 (Tasker
     * freezes lower-priority tasks while the caller polls) and a dismissed
     * dialog fails the read promptly via {@link TaskerShape.taskRunning}.
     */
    const promptFor = (
      path: ReadonlyArray<string>,
      name: string
    ): Effect.Effect<string, ConfigError.ConfigError> =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<string, ConfigError.ConfigError>();
        const existing = yield* Ref.modify(inFlight, (map) => {
          const found = map.get(name);
          if (found !== undefined) return [found, map] as const;
          const next = new Map(map);
          next.set(name, deferred);
          return [undefined, next] as const;
        });
        if (existing !== undefined) {
          return yield* Deferred.await(existing);
        }

        const attempt = Effect.gen(function* () {
          // Perform the prompt one above the caller's priority (%priority is
          // Tasker's built-in local holding this task's priority): only the
          // highest-priority alive task's actions run, so a fixed low
          // priority would leave TE Config queued frozen behind the very
          // task that is polling for its answer. Priority is an optimization,
          // not a correctness requirement — any failure reading it falls
          // back to the constant.
          const callerPriority = yield* tasker.local("priority").pipe(
            Effect.map(parsePriority),
            Effect.orElseSucceed(() => undefined)
          );
          const promptPriority =
            callerPriority !== undefined
              ? callerPriority + 1
              : FALLBACK_PROMPT_PRIORITY;
          const started = yield* tasker
            .performTask(CONFIG_TASK_NAME, promptPriority, name, labels.get(name) ?? name)
            .pipe(Effect.mapError((error) => sourceUnavailable(path, name, error)));
          if (!started) {
            return yield* Effect.fail(
              ConfigError.MissingData(
                [...path],
                `${CONFIG_TASK_NAME} could not be started for %${name} — import tasker-effect.prj.xml`
              )
            );
          }
          // Dismissal detection: taskRunning(TE Config) flipping true → false
          // with the global still unset means the dialog ended without an
          // answer. Deliberately conservative: if we never observe the task
          // running (e.g. it is itself queued behind something) we keep
          // polling and let the overall timeout govern. Known limitation:
          // taskRunning is per-task-name, so with two concurrent TE Config
          // instances (two keys prompting at once) a dismissal of one is
          // masked by the other and that waiter falls back to the timeout.
          let seenRunning = false;
          const pollOnce: Effect.Effect<string | undefined, ConfigError.ConfigError> =
            Effect.gen(function* () {
              yield* Effect.sleep(pollInterval);
              // A transient read failure during polling must not abort the
              // whole wait — treat it as "no answer yet" and let the overall
              // timeout govern.
              const value = yield* readGlobal(path, name).pipe(Effect.orElseSucceed(() => undefined));
              if (value !== undefined) return value;
              const running = yield* tasker.taskRunning(CONFIG_TASK_NAME).pipe(
                // A taskRunning failure must not fail the read: treat it as
                // "still running" and let the overall timeout govern.
                Effect.orElseSucceed(() => true)
              );
              if (running) {
                seenRunning = true;
                return undefined;
              }
              if (!seenRunning) return undefined;
              // The store action sets the global just before the task ends;
              // one final read closes the race where the task finished
              // between the global read above and the taskRunning check.
              const last = yield* readGlobal(path, name).pipe(Effect.orElseSucceed(() => undefined));
              if (last !== undefined) return last;
              return yield* Effect.fail(
                ConfigError.MissingData(
                  [...path],
                  `The ${CONFIG_TASK_NAME} prompt for Tasker global %${name} ended without an answer (dismissed?)`
                )
              );
            });
          return yield* pollOnce.pipe(
            Effect.repeat({ until: (v): v is string => v !== undefined }),
            Effect.timeoutFail({
              duration: timeout,
              onTimeout: () =>
                ConfigError.MissingData(
                  [...path],
                  `Tasker global %${name} is unset and the prompt was not answered within ${Duration.format(timeout)}`
                ),
            })
          );
        });

        // Owner fiber: whatever happens to `attempt` — success, failure, or
        // the owner being interrupted mid-poll — the Deferred must be
        // completed and the in-flight entry removed, or every deduped waiter
        // hangs forever and the stale entry wedges all future reads of the
        // key.
        const cleanup = Ref.update(inFlight, (map) => {
          const next = new Map(map);
          next.delete(name);
          return next;
        });
        return yield* attempt.pipe(
          Effect.onExit((exit) =>
            Deferred.done(
              deferred,
              Exit.isInterrupted(exit)
                ? Exit.fail(
                    ConfigError.MissingData(
                      [...path],
                      `The prompt for Tasker global %${name} was interrupted before an answer arrived`
                    )
                  )
                : exit
            ).pipe(Effect.zipRight(cleanup))
          )
        );
      });

    const load = <A>(
      path: ReadonlyArray<string>,
      config: Config.Config.Primitive<A>,
      split: boolean
    ): Effect.Effect<Array<A>, ConfigError.ConfigError> =>
      Effect.gen(function* () {
        const name = globalNameOf(path);
        const current = yield* readGlobal(path, name);
        const text = current !== undefined ? current : yield* promptFor(path, name);
        // `split` is set for sequence configs (Config.array & co.): a single
        // global then holds a comma-separated list, like env-based providers.
        const texts = split ? text.split(",").map((part) => part.trim()) : [text];
        return yield* Effect.forEach(texts, (part) =>
          config
            .parse(part)
            .pipe(Effect.mapError((error) => ConfigError.prefixed(error, [...path])))
        );
      });

    return ConfigProvider.fromFlat(
      ConfigProvider.makeFlat({
        load,
        // Tasker cannot enumerate globals, so Config.record and friends see
        // an empty keyspace.
        enumerateChildren: () => Effect.succeed(HashSet.empty<string>()),
        patch: ConfigProviderPathPatch.empty,
      })
    );
  });

/**
 * Layer installing the Tasker config provider for a program:
 *
 * ```typescript
 * const API_KEY = secret("OPENWEATHER_KEY", "OpenWeather API key");
 *
 * const program = Effect.gen(function* () {
 *   const key = yield* Config.string("OPENWEATHER_KEY"); // prompts if unset
 *   // ...
 * });
 *
 * runInTasker(program.pipe(
 *   Effect.provide(taskerConfigLayer({ secrets: [API_KEY] }))
 * ));
 * ```
 */
export const taskerConfigLayer = (
  options?: TaskerConfigOptions
): Layer.Layer<never> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const tasker = yield* Tasker;
      const provider = yield* makeTaskerConfigProvider(tasker, options);
      return Layer.setConfigProvider(provider);
    })
  ).pipe(Layer.provide(Tasker.Default));
