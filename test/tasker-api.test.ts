import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import {
  Tasker,
  TaskerTest,
  makeTaskerTestLayer,
  TaskerCallError,
  TaskerNotAvailableError,
  TASKER_FUNCTION_NAMES,
  raw,
} from "../src/tasker-api.js";

describe("Tasker service (test layer)", () => {
  it.effect("flash succeeds and global returns empty string", () =>
    Effect.gen(function* () {
      const tasker = yield* Tasker;
      yield* tasker.flash("hello");
      const result = yield* tasker.global("BATT");
      expect(result).toBe("");
    }).pipe(Effect.provide(TaskerTest))
  );

  it.effect("records calls with arguments", () =>
    Effect.gen(function* () {
      const { layer, calls } = makeTaskerTestLayer();

      yield* Effect.gen(function* () {
        const tasker = yield* Tasker;
        yield* tasker.setGlobal("MODE", "night");
        yield* tasker.performTask("Sync", 10);
      }).pipe(Effect.provide(layer));

      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual({ name: "setGlobal", args: ["MODE", "night"] });
      expect(calls[1]?.name).toBe("performTask");
    })
  );

  it.effect("supports overrides", () =>
    Effect.gen(function* () {
      const { layer } = makeTaskerTestLayer({
        global: (name) => Effect.succeed(name === "BATT" ? "88" : ""),
      });

      const result = yield* Effect.gen(function* () {
        const tasker = yield* Tasker;
        return yield* tasker.global("BATT");
      }).pipe(Effect.provide(layer));
      expect(result).toBe("88");
    })
  );

  it.effect("getVoice defaults to an empty array", () =>
    Effect.gen(function* () {
      const tasker = yield* Tasker;
      const result = yield* tasker.getVoice("prompt", "web", 5);
      expect(result).toEqual([]);
    }).pipe(Effect.provide(TaskerTest))
  );

  it.effect("isAvailable is false in the test layer", () =>
    Effect.gen(function* () {
      const tasker = yield* Tasker;
      const result = yield* tasker.isAvailable;
      expect(result).toBe(false);
    }).pipe(Effect.provide(TaskerTest))
  );
});

describe("Tasker service (default/live layer)", () => {
  it.effect("fails with TaskerNotAvailableError off-device", () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const tasker = yield* Tasker;
        yield* tasker.flash("hello");
      });

      const exit = yield* Effect.exit(
        program.pipe(Effect.provide(Tasker.Default))
      );
      expect(Exit.isFailure(exit)).toBe(true);

      const error = yield* program.pipe(
        Effect.provide(Tasker.Default),
        Effect.flip
      );
      expect(error._tag).toBe("TaskerNotAvailableError");
    })
  );

  it.effect("uses an injected global when present", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      (globalThis as Record<string, unknown>).flash = (message: string) => {
        seen.push(message);
      };
      yield* Effect.gen(function* () {
        const tasker = yield* Tasker;
        yield* tasker.flash("on-device");
      }).pipe(
        Effect.provide(Tasker.Default),
        Effect.ensuring(
          Effect.sync(() => {
            delete (globalThis as Record<string, unknown>).flash;
          })
        )
      );
      expect(seen).toEqual(["on-device"]);
    })
  );

  it.effect("wraps a throwing global in TaskerCallError", () =>
    Effect.gen(function* () {
      (globalThis as Record<string, unknown>).flash = () => {
        throw new Error("device exploded");
      };
      const error = yield* Effect.gen(function* () {
        const tasker = yield* Tasker;
        yield* tasker.flash("hello");
      }).pipe(
        Effect.provide(Tasker.Default),
        Effect.flip,
        Effect.ensuring(
          Effect.sync(() => {
            delete (globalThis as Record<string, unknown>).flash;
          })
        )
      );
      expect(error).toBeInstanceOf(TaskerCallError);
      expect(error.message).toContain("device exploded");
    })
  );

  it.effect("isAvailable is true on-device when flash is defined", () =>
    Effect.gen(function* () {
      (globalThis as Record<string, unknown>).flash = () => {};
      const result = yield* Effect.gen(function* () {
        const tasker = yield* Tasker;
        return yield* tasker.isAvailable;
      }).pipe(
        Effect.provide(Tasker.Default),
        Effect.ensuring(
          Effect.sync(() => {
            delete (globalThis as Record<string, unknown>).flash;
          })
        )
      );
      expect(result).toBe(true);
    })
  );
});

describe("raw escape hatch", () => {
  it("throws TaskerNotAvailableError when the builtin is missing", () => {
    expect(() => raw.vibrate(100)).toThrow(TaskerNotAvailableError);
  });

  it("calls through to an injected global", () => {
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
  it("covers a representative sample of the documented API", () => {
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
