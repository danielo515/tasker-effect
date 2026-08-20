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
  Ref,
} from "effect";
import { CONFIG_TASK_NAME } from "./compiler.js";
import type { Secret } from "./profile.js";
import { Tasker, type TaskerApiError, type TaskerShape } from "./tasker-api.js";

/** The slice of the Tasker API the provider needs (test with makeTestTasker) */
export type TaskerConfigApi = Pick<TaskerShape, "global" | "performTask">;

/** Options for the Tasker config provider */
export interface TaskerConfigOptions {
  /** Declared secrets, used for human-readable prompt labels */
  readonly secrets?: ReadonlyArray<Secret>;
  /** How long to wait for a prompt answer. Default: 120s */
  readonly promptTimeoutMillis?: number;
  /** How often to poll the global while waiting. Default: 1s */
  readonly pollIntervalMillis?: number;
}

/** Priority used when performing the TE Config prompt task */
const PROMPT_TASK_PRIORITY = 5;

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
    const pollInterval = options?.pollIntervalMillis ?? 1_000;
    const timeout = options?.promptTimeoutMillis ?? 120_000;
    const inFlight = yield* Ref.make(
      new Map<string, Deferred.Deferred<string, ConfigError.ConfigError>>()
    );

    const readGlobal = (
      path: ReadonlyArray<string>,
      name: string
    ): Effect.Effect<string | undefined, ConfigError.ConfigError> =>
      tasker.global(name).pipe(
        Effect.mapError((error) => sourceUnavailable(path, name, error)),
        Effect.map((value) => {
          // Tasker returns undefined for unset globals despite the binding's
          // string type; treat empty as unset either way.
          const text: string | undefined = value;
          return text === undefined || text === "" ? undefined : text;
        })
      );

    /** Prompt once per key: concurrent readers await the same Deferred. */
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
          yield* tasker
            .performTask(
              CONFIG_TASK_NAME,
              PROMPT_TASK_PRIORITY,
              name,
              labels.get(name) ?? name
            )
            .pipe(Effect.mapError((error) => sourceUnavailable(path, name, error)));
          const attempts = Math.max(1, Math.ceil(timeout / pollInterval));
          for (let i = 0; i < attempts; i++) {
            yield* Effect.sleep(Duration.millis(pollInterval));
            const value = yield* readGlobal(path, name);
            if (value !== undefined) return value;
          }
          return yield* Effect.fail(
            ConfigError.MissingData(
              [...path],
              `Tasker global %${name} is unset and the prompt was not answered within ${timeout}ms`
            )
          );
        });

        const result: Exit.Exit<string, ConfigError.ConfigError> =
          yield* Effect.exit(attempt);
        yield* Deferred.done(deferred, result);
        yield* Ref.update(inFlight, (map) => {
          const next = new Map(map);
          next.delete(name);
          return next;
        });
        return yield* result;
      });

    const load = <A>(
      path: ReadonlyArray<string>,
      config: Config.Config.Primitive<A>,
      _split: boolean
    ): Effect.Effect<Array<A>, ConfigError.ConfigError> =>
      Effect.gen(function* () {
        const name = globalNameOf(path);
        const current = yield* readGlobal(path, name);
        const text = current !== undefined ? current : yield* promptFor(path, name);
        const parsed = yield* config.parse(text);
        return [parsed];
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
