import { afterEach, describe, expect, it } from "@effect/vitest";
import { Config, ConfigError, Effect, Fiber } from "effect";
import { CONFIG_TASK_NAME } from "../src/compiler.js";
import { makeTaskerConfigProvider, taskerConfigLayer } from "../src/config.js";
import { secret } from "../src/profile.js";
import {
  makeTestTasker,
  TaskerCallError,
  type TaskerApi,
} from "../src/tasker-api.js";

const API_KEY = secret("OPENWEATHER_KEY", "OpenWeather API key");

/**
 * Test double: a Tasker whose globals live in a Map, where performing the
 * TE Config task "answers the prompt" by setting the requested global.
 */
const makePromptingTasker = (options?: {
  readonly globals?: Record<string, string>;
  readonly answer?: string;
  readonly overrides?: Partial<TaskerApi>;
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
      ...options?.overrides,
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

  it.live("performs the prompt one above the caller's %priority", () =>
    Effect.gen(function* () {
      const { api, calls } = makePromptingTasker({
        answer: "x",
        overrides: {
          local: (name) => Effect.succeed(name === "priority" ? "12" : ""),
        },
      });
      const provider = yield* makeTaskerConfigProvider(api, FAST);
      yield* Effect.withConfigProvider(
        Config.string("OPENWEATHER_KEY"),
        provider
      );
      const prompt = calls.find((call) => call.name === "performTask");
      expect(prompt?.args).toEqual([
        CONFIG_TASK_NAME,
        13,
        "OPENWEATHER_KEY",
        "OPENWEATHER_KEY",
      ]);
    })
  );

  it.live("a failing %priority read falls back to the constant and does not fail the read", () =>
    Effect.gen(function* () {
      const { api, calls } = makePromptingTasker({
        answer: "still-works",
        overrides: {
          local: () =>
            Effect.fail(
              new TaskerCallError({ function: "local", message: "boom" })
            ),
        },
      });
      const provider = yield* makeTaskerConfigProvider(api, FAST);
      const value = yield* Effect.withConfigProvider(
        Config.string("OPENWEATHER_KEY"),
        provider
      );
      expect(value).toBe("still-works");
      const prompt = calls.find((call) => call.name === "performTask");
      expect(prompt?.args[1]).toBe(5);
    })
  );

  it.live("a negative or non-numeric %priority falls back to the constant", () =>
    Effect.gen(function* () {
      const { api, calls } = makePromptingTasker({
        answer: "x",
        overrides: {
          local: (name) => Effect.succeed(name === "priority" ? "-1" : ""),
        },
      });
      const provider = yield* makeTaskerConfigProvider(api, FAST);
      yield* Effect.withConfigProvider(Config.string("OPENWEATHER_KEY"), provider);
      const prompt = calls.find((call) => call.name === "performTask");
      expect(prompt?.args[1]).toBe(5);
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

  it.live("a dismissed prompt fails promptly with MissingData and composes with Config.withDefault", () =>
    Effect.gen(function* () {
      // TE Config is seen running, then stops without ever setting the
      // global: the user dismissed the dialog. The read must fail well
      // before the generous 5s prompt timeout — a regression to
      // timeout-only behavior trips the 1s guards below.
      const GENEROUS = { pollIntervalMillis: 5, promptTimeoutMillis: 5_000 };
      const dismissedTasker = () => {
        let checks = 0;
        return makePromptingTasker({
          overrides: {
            taskRunning: () => Effect.sync(() => ++checks <= 2),
          },
        });
      };

      const errorProvider = yield* makeTaskerConfigProvider(
        dismissedTasker().api,
        GENEROUS
      );
      const error = yield* Effect.withConfigProvider(
        Config.string("OPENWEATHER_KEY"),
        errorProvider
      ).pipe(
        Effect.flip,
        Effect.timeoutFail({
          duration: "1 second",
          onTimeout: () => "dismissal was not detected promptly" as const,
        })
      );
      expect(ConfigError.isConfigError(error)).toBe(true);
      expect(ConfigError.isMissingDataOnly(error)).toBe(true);
      // oxlint-disable-next-line typescript/no-base-to-string -- ConfigError stringifies meaningfully at runtime
      expect(String(error)).toContain("OPENWEATHER_KEY");
      // oxlint-disable-next-line typescript/no-base-to-string -- ConfigError stringifies meaningfully at runtime
      expect(String(error)).toContain("without an answer");

      const fallbackProvider = yield* makeTaskerConfigProvider(
        dismissedTasker().api,
        GENEROUS
      );
      const fallback = yield* Effect.withConfigProvider(
        Config.withDefault(Config.string("OPENWEATHER_KEY"), "default"),
        fallbackProvider
      ).pipe(
        Effect.timeoutFail({
          duration: "1 second",
          onTimeout: () => "fallback was not reached promptly" as const,
        })
      );
      expect(fallback).toBe("default");
    })
  );

  it.live("does not fail while the prompt task has not started yet (start race)", () =>
    Effect.gen(function* () {
      // taskRunning is false while TE Config is still queued; only a
      // true → false transition may fail the read.
      const globals = new Map<string, string>();
      let checks = 0;
      const { api } = makeTestTasker({
        global: (name) => Effect.succeed(globals.get(name) ?? ""),
        taskRunning: () =>
          Effect.sync(() => {
            checks++;
            if (checks <= 3) return false; // queued, not yet started
            if (checks >= 6) globals.set("OPENWEATHER_KEY", "late-start"); // answered
            return true;
          }),
      });
      const provider = yield* makeTaskerConfigProvider(api, {
        pollIntervalMillis: 5,
        promptTimeoutMillis: 5_000,
      });
      const value = yield* Effect.withConfigProvider(
        Config.string("OPENWEATHER_KEY"),
        provider
      );
      expect(value).toBe("late-start");
    })
  );

  it.live("returns the value stored just before the task ended (end race)", () =>
    Effect.gen(function* () {
      // The store action sets the global right before TE Config exits, so
      // the poll may observe the global unset and then taskRunning false:
      // the final re-read must pick the value up instead of reporting a
      // dismissal.
      const globals = new Map<string, string>();
      let checks = 0;
      const { api } = makeTestTasker({
        global: (name) => Effect.succeed(globals.get(name) ?? ""),
        taskRunning: () =>
          Effect.sync(() => {
            checks++;
            if (checks < 3) return true;
            globals.set("OPENWEATHER_KEY", "stored-at-exit");
            return false;
          }),
      });
      const provider = yield* makeTaskerConfigProvider(api, {
        pollIntervalMillis: 5,
        promptTimeoutMillis: 5_000,
      });
      const value = yield* Effect.withConfigProvider(
        Config.string("OPENWEATHER_KEY"),
        provider
      ).pipe(
        Effect.timeoutFail({
          duration: "1 second",
          onTimeout: () => "end race was not resolved promptly" as const,
        })
      );
      expect(value).toBe("stored-at-exit");
    })
  );

  it.live("a failing taskRunning check is treated as still-running, not a dismissal", () =>
    Effect.gen(function* () {
      // taskRunning itself failing (e.g. TaskerCallError) must not fail the
      // read or be mistaken for a dismissal: it falls back to "still
      // running" and the eventual answer still comes through.
      const { api } = makeTestTasker({
        global: () => Effect.succeed(""),
        taskRunning: () =>
          Effect.fail(
            new TaskerCallError({ function: "taskRunning", message: "boom" })
          ),
      });
      const provider = yield* makeTaskerConfigProvider(api, {
        pollIntervalMillis: 5,
        promptTimeoutMillis: 50,
      });
      const error = yield* Effect.withConfigProvider(
        Config.string("OPENWEATHER_KEY"),
        provider
      ).pipe(Effect.flip);
      // Never answered, so it times out normally rather than reporting a
      // dismissal — proving the taskRunning failure was swallowed.
      expect(ConfigError.isConfigError(error)).toBe(true);
      // oxlint-disable-next-line typescript/no-base-to-string -- ConfigError stringifies meaningfully at runtime
      expect(String(error)).not.toContain("dismissed");
      // oxlint-disable-next-line typescript/no-base-to-string -- ConfigError stringifies meaningfully at runtime
      expect(String(error)).toContain("was not answered within");
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
