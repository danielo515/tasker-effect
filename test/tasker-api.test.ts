import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
  Tasker,
  TaskerTest,
  makeTaskerTestLayer,
  TaskerNotAvailableError,
  TASKER_FUNCTION_NAMES,
  raw,
} from "../src/tasker-api.js";

describe("Tasker service (test layer)", () => {
  test("flash succeeds and global returns empty string", async () => {
    const program = Effect.gen(function* () {
      const tasker = yield* Tasker;
      yield* tasker.flash("hello");
      return yield* tasker.global("BATT");
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TaskerTest))
    );
    expect(result).toBe("");
  });

  test("records calls with arguments", async () => {
    const { layer, calls } = makeTaskerTestLayer();

    const program = Effect.gen(function* () {
      const tasker = yield* Tasker;
      yield* tasker.setGlobal("MODE", "night");
      yield* tasker.performTask("Sync", 10);
    });

    await Effect.runPromise(program.pipe(Effect.provide(layer)));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ name: "setGlobal", args: ["MODE", "night"] });
    expect(calls[1]?.name).toBe("performTask");
  });

  test("supports overrides", async () => {
    const { layer } = makeTaskerTestLayer({
      global: (name) => Effect.succeed(name === "BATT" ? "88" : ""),
    });

    const program = Effect.gen(function* () {
      const tasker = yield* Tasker;
      return yield* tasker.global("BATT");
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
    expect(result).toBe("88");
  });

  test("isAvailable is false in the test layer", async () => {
    const program = Effect.gen(function* () {
      const tasker = yield* Tasker;
      return yield* tasker.isAvailable;
    });
    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TaskerTest))
    );
    expect(result).toBe(false);
  });
});

describe("Tasker service (default/live layer)", () => {
  test("fails with TaskerNotAvailableError off-device", async () => {
    const program = Effect.gen(function* () {
      const tasker = yield* Tasker;
      yield* tasker.flash("hello");
    });

    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(Tasker.Default))
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const error = await Effect.runPromise(
      program.pipe(
        Effect.provide(Tasker.Default),
        Effect.flip
      )
    );
    expect(error._tag).toBe("TaskerNotAvailableError");
  });

  test("uses an injected global when present", async () => {
    const seen: Array<string> = [];
    (globalThis as Record<string, unknown>).flash = (message: string) => {
      seen.push(message);
    };
    try {
      const program = Effect.gen(function* () {
        const tasker = yield* Tasker;
        yield* tasker.flash("on-device");
      });
      await Effect.runPromise(program.pipe(Effect.provide(Tasker.Default)));
      expect(seen).toEqual(["on-device"]);
    } finally {
      delete (globalThis as Record<string, unknown>).flash;
    }
  });
});

describe("raw escape hatch", () => {
  test("throws TaskerNotAvailableError when the builtin is missing", () => {
    expect(() => raw.vibrate(100)).toThrow(TaskerNotAvailableError);
  });

  test("calls through to an injected global", () => {
    (globalThis as Record<string, unknown>).convert = (val: string) =>
      val.toUpperCase();
    try {
      expect(raw.convert("abc", "urlEncode")).toBe("ABC");
    } finally {
      delete (globalThis as Record<string, unknown>).convert;
    }
  });
});

describe("function name list", () => {
  test("covers a representative sample of the documented API", () => {
    for (const name of [
      "flash",
      "performTask",
      "setWallpaper",
      "getLocation",
      "sendIntent",
      "encryptFile",
      "elemText",
      "takePhoto",
      "sl4a",
    ]) {
      expect(TASKER_FUNCTION_NAMES).toContain(name);
    }
    expect(TASKER_FUNCTION_NAMES.length).toBeGreaterThan(100);
  });
});
