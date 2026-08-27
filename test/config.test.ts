import { afterEach, describe, expect, it } from "@effect/vitest";
import { Config, ConfigError, Effect, Fiber } from "effect";
import { CONFIG_TASK_NAME } from "../src/compiler.js";
import { makeTaskerConfigProvider, taskerConfigLayer } from "../src/config.js";
import { secret } from "../src/profile.js";
import { makeTestTasker, TaskerCallError } from "../src/tasker-api.js";

const API_KEY = secret("OPENWEATHER_KEY", "OpenWeather API key");

/**
 * Test double: a Tasker whose globals live in a Map, where performing the
 * TE Config task "answers the prompt" by setting the requested global.
 */
const makePromptingTasker = (options?: {
  readonly globals?: Record<string, string>;
  readonly answer?: string;
}) => {
  const globals = new Map(Object.entries(options?.globals ?? {}));
  return {
    globals,
    ...makeTestTasker({
      global: (name) => Effect.succeed(globals.get(name) ?? ""),
      performTask: (_task, _priority, par1) =>
        Effect.sync(() => {
          if (options?.answer !== undefined && par1 !== undefined) {
            globals.set(par1, options.answer);
          }
          return true;
        }),
    }),
  };
};

const FAST = { pollIntervalMillis: 5, promptTimeoutMillis: 100 };

// Tests that hit the prompt path use it.live: the provider polls the global
// with real Clock sleeps, which the TestClock of it.effect would never
// advance.
describe("makeTaskerConfigProvider", () => {
  it.effect("reads a set global without prompting", () =>
    Effect.gen(function* () {
      const { api, calls } = makePromptingTasker({
        globals: { OPENWEATHER_KEY: "abc123" },
      });
      const provider = yield* makeTaskerConfigProvider(api, FAST);
      const value = yield* Effect.withConfigProvider(
        Config.string("OPENWEATHER_KEY"),
        provider
      );
      expect(value).toBe("abc123");
      expect(calls.filter((call) => call.name === "performTask")).toHaveLength(0);
    })
  );

  it.live("prompts via TE Config for a missing key and returns the answer", () =>
    Effect.gen(function* () {
      const { api, calls } = makePromptingTasker({ answer: "hunter2" });
      const provider = yield* makeTaskerConfigProvider(api, {
        ...FAST,
        secrets: [API_KEY],
      });
      const value = yield* Effect.withConfigProvider(
        Config.string("OPENWEATHER_KEY"),
        provider
      );
      expect(value).toBe("hunter2");
      const prompts = calls.filter((call) => call.name === "performTask");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.args).toEqual([
        CONFIG_TASK_NAME,
        5,
        "OPENWEATHER_KEY",
        "OpenWeather API key",
      ]);
    })
  );

  it.live("prompts with the bare name when the key is not a declared secret", () =>
    Effect.gen(function* () {
      const { api, calls } = makePromptingTasker({ answer: "x" });
      const provider = yield* makeTaskerConfigProvider(api, FAST);
      yield* Effect.withConfigProvider(Config.string("SOME_KEY"), provider);
      const prompt = calls.find((call) => call.name === "performTask");
      expect(prompt?.args).toEqual([CONFIG_TASK_NAME, 5, "SOME_KEY", "SOME_KEY"]);
    })
  );

  it.effect("nested config paths map to underscore-joined uppercase globals", () =>
    Effect.gen(function* () {
      const { api } = makePromptingTasker({ globals: { TE_KEY: "nested" } });
      const provider = yield* makeTaskerConfigProvider(api, FAST);
      const value = yield* Effect.withConfigProvider(
        Config.nested(Config.string("key"), "te"),
        provider
      );
      expect(value).toBe("nested");
    })
  );

  it.live("an unanswered prompt fails with ConfigError and composes with Config.option", () =>
    Effect.gen(function* () {
      const { api } = makePromptingTasker(); // no answer: the global stays unset
      const provider = yield* makeTaskerConfigProvider(api, FAST);
      const error = yield* Effect.withConfigProvider(
        Config.string("OPENWEATHER_KEY"),
        provider
      ).pipe(Effect.flip);
      expect(ConfigError.isConfigError(error)).toBe(true);
      expect(ConfigError.isMissingDataOnly(error)).toBe(true);
      // oxlint-disable-next-line typescript/no-base-to-string -- ConfigError stringifies meaningfully at runtime
      expect(String(error)).toContain("OPENWEATHER_KEY");

      const fallback = yield* Effect.withConfigProvider(
        Config.withDefault(Config.string("OPENWEATHER_KEY"), "default"),
        provider
      );
      expect(fallback).toBe("default");
    })
  );

  it.live("concurrent reads of the same missing key prompt once", () =>
    Effect.gen(function* () {
      const { api, calls } = makePromptingTasker({ answer: "once" });
      const provider = yield* makeTaskerConfigProvider(api, FAST);
      const values = yield* Effect.all(
        [
          Effect.withConfigProvider(Config.string("OPENWEATHER_KEY"), provider),
          Effect.withConfigProvider(Config.string("OPENWEATHER_KEY"), provider),
        ],
        { concurrency: 2 }
      );
      expect(values).toEqual(["once", "once"]);
      expect(calls.filter((call) => call.name === "performTask")).toHaveLength(1);
    })
  );

  it.effect("non-string configs parse the global's text", () =>
    Effect.gen(function* () {
      const { api } = makePromptingTasker({ globals: { RETRIES: "3" } });
      const provider = yield* makeTaskerConfigProvider(api, FAST);
      const value = yield* Effect.withConfigProvider(
        Config.integer("RETRIES"),
        provider
      );
      expect(value).toBe(3);
    })
  );

  it.effect("sequence configs split the global on commas", () =>
    Effect.gen(function* () {
      const { api } = makePromptingTasker({
        globals: { HOSTS: "a.local, b.local,c.local" },
      });
      const provider = yield* makeTaskerConfigProvider(api, FAST);
      const value = yield* Effect.withConfigProvider(
        Config.array(Config.string(), "HOSTS"),
        provider
      );
      expect(value).toEqual(["a.local", "b.local", "c.local"]);
    })
  );

  it.effect("parse failures carry the config path", () =>
    Effect.gen(function* () {
      const { api } = makePromptingTasker({ globals: { RETRIES: "not-a-number" } });
      const provider = yield* makeTaskerConfigProvider(api, FAST);
      const error = yield* Effect.withConfigProvider(
        Config.integer("RETRIES"),
        provider
      ).pipe(Effect.flip);
      expect(ConfigError.isConfigError(error)).toBe(true);
      // oxlint-disable-next-line typescript/no-base-to-string -- ConfigError stringifies meaningfully at runtime
      expect(String(error)).toContain("RETRIES");
    })
  );

  it.live(
    "interrupting the prompting fiber fails waiters instead of hanging them, and clears the in-flight entry",
    () =>
      Effect.gen(function* () {
        // Prompts go unanswered until we flip `answer` after the interruption.
        let answer: string | undefined;
        const globals = new Map<string, string>();
        const { api, calls } = makeTestTasker({
          global: (name) => Effect.succeed(globals.get(name) ?? ""),
          performTask: (_task, _priority, par1) =>
            Effect.sync(() => {
              if (answer !== undefined && par1 !== undefined) {
                globals.set(par1, answer);
              }
              return true;
            }),
        });

        const provider = yield* makeTaskerConfigProvider(api, {
          pollIntervalMillis: 10,
          promptTimeoutMillis: 5_000,
        });
        const readKey = Effect.withConfigProvider(
          Config.string("OPENWEATHER_KEY"),
          provider
        );

        const owner = yield* Effect.fork(readKey);
        yield* Effect.sleep("30 millis"); // owner has prompted and is polling
        const waiter = yield* Effect.fork(readKey.pipe(Effect.flip));
        yield* Effect.sleep("10 millis"); // waiter deduped onto the owner
        yield* Fiber.interrupt(owner);

        // The waiter must fail with a ConfigError promptly — not hang on a
        // Deferred nobody will ever complete.
        const waiterError = yield* Fiber.join(waiter).pipe(
          Effect.timeoutFail({
            duration: "1 second",
            onTimeout: () => "waiter hung" as const,
          })
        );

        // The in-flight entry must be gone: a later read goes through the
        // prompt path again (global still unset) and now succeeds.
        answer = "late-answer";
        const later = yield* readKey.pipe(
          Effect.timeoutFail({
            duration: "1 second",
            onTimeout: () => "stale in-flight entry wedged the retry" as const,
          })
        );

        expect(ConfigError.isConfigError(waiterError as unknown)).toBe(true);
        // oxlint-disable-next-line typescript/no-base-to-string -- ConfigError stringifies meaningfully at runtime
        expect(String(waiterError)).toContain("interrupted");
        expect(later).toBe("late-answer");
        expect(calls.filter((call) => call.name === "performTask")).toHaveLength(2);
      })
  );

  it.effect("wraps a failing global() read in SourceUnavailable", () =>
    Effect.gen(function* () {
      const { api } = makeTestTasker({
        global: () =>
          Effect.fail(new TaskerCallError({ function: "global", message: "no globals" })),
      });
      const provider = yield* makeTaskerConfigProvider(api, FAST);
      const error = yield* Effect.withConfigProvider(
        Config.string("OPENWEATHER_KEY"),
        provider
      ).pipe(Effect.flip);
      expect(ConfigError.isConfigError(error)).toBe(true);
      // oxlint-disable-next-line typescript/no-base-to-string -- ConfigError stringifies meaningfully at runtime
      expect(String(error)).toContain("no globals");
    })
  );

  it.live("wraps a failing performTask() prompt in SourceUnavailable", () =>
    Effect.gen(function* () {
      const { api } = makeTestTasker({
        global: () => Effect.succeed(""),
        performTask: () =>
          Effect.fail(new TaskerCallError({ function: "performTask", message: "no task runner" })),
      });
      const provider = yield* makeTaskerConfigProvider(api, FAST);
      const error = yield* Effect.withConfigProvider(
        Config.string("OPENWEATHER_KEY"),
        provider
      ).pipe(Effect.flip);
      expect(ConfigError.isConfigError(error)).toBe(true);
      // oxlint-disable-next-line typescript/no-base-to-string -- ConfigError stringifies meaningfully at runtime
      expect(String(error)).toContain("no task runner");
    })
  );
});

describe("taskerConfigLayer", () => {
  const g = globalThis as Record<string, unknown>;

  afterEach(() => {
    delete g.global;
    delete g.performTask;
  });

  it.effect("installs a ConfigProvider backed by the live Tasker globals", () =>
    Effect.gen(function* () {
      g.global = (name: string) => (name === "OPENWEATHER_KEY" ? "live-value" : "");
      const value = yield* Config.string("OPENWEATHER_KEY").pipe(
        Effect.provide(taskerConfigLayer({ secrets: [API_KEY] }))
      );
      expect(value).toBe("live-value");
    })
  );
});
