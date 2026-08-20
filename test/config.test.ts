import { describe, expect, test } from "bun:test";
import { Config, ConfigError, Effect, Fiber } from "effect";
import { CONFIG_TASK_NAME } from "../src/compiler.js";
import { makeTaskerConfigProvider } from "../src/config.js";
import { secret } from "../src/profile.js";
import { makeTestTasker } from "../src/tasker-api.js";

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

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("makeTaskerConfigProvider", () => {
  test("reads a set global without prompting", async () => {
    const { api, calls } = makePromptingTasker({
      globals: { OPENWEATHER_KEY: "abc123" },
    });
    const value = await run(
      Effect.gen(function* () {
        const provider = yield* makeTaskerConfigProvider(api, FAST);
        return yield* Effect.withConfigProvider(
          Config.string("OPENWEATHER_KEY"),
          provider
        );
      })
    );
    expect(value).toBe("abc123");
    expect(calls.filter((call) => call.name === "performTask")).toHaveLength(0);
  });

  test("prompts via TE Config for a missing key and returns the answer", async () => {
    const { api, calls } = makePromptingTasker({ answer: "hunter2" });
    const value = await run(
      Effect.gen(function* () {
        const provider = yield* makeTaskerConfigProvider(api, {
          ...FAST,
          secrets: [API_KEY],
        });
        return yield* Effect.withConfigProvider(
          Config.string("OPENWEATHER_KEY"),
          provider
        );
      })
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
  });

  test("prompts with the bare name when the key is not a declared secret", async () => {
    const { api, calls } = makePromptingTasker({ answer: "x" });
    await run(
      Effect.gen(function* () {
        const provider = yield* makeTaskerConfigProvider(api, FAST);
        return yield* Effect.withConfigProvider(Config.string("SOME_KEY"), provider);
      })
    );
    const prompt = calls.find((call) => call.name === "performTask");
    expect(prompt?.args).toEqual([CONFIG_TASK_NAME, 5, "SOME_KEY", "SOME_KEY"]);
  });

  test("nested config paths map to underscore-joined uppercase globals", async () => {
    const { api } = makePromptingTasker({ globals: { TE_KEY: "nested" } });
    const value = await run(
      Effect.gen(function* () {
        const provider = yield* makeTaskerConfigProvider(api, FAST);
        return yield* Effect.withConfigProvider(
          Config.nested(Config.string("key"), "te"),
          provider
        );
      })
    );
    expect(value).toBe("nested");
  });

  test("an unanswered prompt fails with ConfigError and composes with Config.option", async () => {
    const { api } = makePromptingTasker(); // no answer: the global stays unset
    const error = await run(
      Effect.gen(function* () {
        const provider = yield* makeTaskerConfigProvider(api, FAST);
        return yield* Effect.withConfigProvider(
          Config.string("OPENWEATHER_KEY"),
          provider
        );
      }).pipe(Effect.flip)
    );
    expect(ConfigError.isConfigError(error)).toBe(true);
    expect(ConfigError.isMissingDataOnly(error)).toBe(true);
    expect(String(error)).toContain("OPENWEATHER_KEY");

    const fallback = await run(
      Effect.gen(function* () {
        const provider = yield* makeTaskerConfigProvider(api, FAST);
        return yield* Effect.withConfigProvider(
          Config.withDefault(Config.string("OPENWEATHER_KEY"), "default"),
          provider
        );
      })
    );
    expect(fallback).toBe("default");
  });

  test("concurrent reads of the same missing key prompt once", async () => {
    const { api, calls } = makePromptingTasker({ answer: "once" });
    const values = await run(
      Effect.gen(function* () {
        const provider = yield* makeTaskerConfigProvider(api, FAST);
        return yield* Effect.all(
          [
            Effect.withConfigProvider(Config.string("OPENWEATHER_KEY"), provider),
            Effect.withConfigProvider(Config.string("OPENWEATHER_KEY"), provider),
          ],
          { concurrency: 2 }
        );
      })
    );
    expect(values).toEqual(["once", "once"]);
    expect(calls.filter((call) => call.name === "performTask")).toHaveLength(1);
  });

  test("non-string configs parse the global's text", async () => {
    const { api } = makePromptingTasker({ globals: { RETRIES: "3" } });
    const value = await run(
      Effect.gen(function* () {
        const provider = yield* makeTaskerConfigProvider(api, FAST);
        return yield* Effect.withConfigProvider(Config.integer("RETRIES"), provider);
      })
    );
    expect(value).toBe(3);
  });

  test("sequence configs split the global on commas", async () => {
    const { api } = makePromptingTasker({ globals: { HOSTS: "a.local, b.local,c.local" } });
    const value = await run(
      Effect.gen(function* () {
        const provider = yield* makeTaskerConfigProvider(api, FAST);
        return yield* Effect.withConfigProvider(
          Config.array(Config.string(), "HOSTS"),
          provider
        );
      })
    );
    expect(value).toEqual(["a.local", "b.local", "c.local"]);
  });

  test("parse failures carry the config path", async () => {
    const { api } = makePromptingTasker({ globals: { RETRIES: "not-a-number" } });
    const error = await run(
      Effect.gen(function* () {
        const provider = yield* makeTaskerConfigProvider(api, FAST);
        return yield* Effect.withConfigProvider(Config.integer("RETRIES"), provider);
      }).pipe(Effect.flip)
    );
    expect(ConfigError.isConfigError(error)).toBe(true);
    expect(String(error)).toContain("RETRIES");
  });

  test("interrupting the prompting fiber fails waiters instead of hanging them, and clears the in-flight entry", async () => {
    // Prompts go unanswered until we flip `answer` after the interruption.
    let answer: string | undefined;
    const globals = new Map<string, string>();
    const { api, calls } = makeTestTasker({
      global: (name) => Effect.succeed(globals.get(name) ?? ""),
      performTask: (_task, _priority, par1) =>
        Effect.sync(() => {
          if (answer !== undefined && par1 !== undefined) globals.set(par1, answer);
          return true;
        }),
    });

    const outcome = await run(
      Effect.gen(function* () {
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
        return { waiterError, later };
      })
    );
    expect(ConfigError.isConfigError(outcome.waiterError as unknown)).toBe(true);
    expect(String(outcome.waiterError)).toContain("interrupted");
    expect(outcome.later).toBe("late-answer");
    expect(calls.filter((call) => call.name === "performTask")).toHaveLength(2);
  });
});
