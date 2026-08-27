import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  TaskerFileStore,
  TaskerZipExtractor,
  pullLatestProfiles,
} from "../src/sync/tasker.js";
import { FileStore, ZipExtractor } from "../src/sync/contract.js";

const g = globalThis as Record<string, unknown>;

describe("TaskerFileStore", () => {
  afterEach(() => {
    delete g.writeFile;
  });

  it.effect("writeText calls the Tasker writeFile builtin", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      g.writeFile = (path: string, content: string, append: boolean) => {
        calls.push([path, content, append]);
        return true;
      };
      yield* Effect.gen(function* () {
        const store = yield* FileStore;
        yield* store.writeText("/sdcard/x.js", "content");
      }).pipe(Effect.provide(TaskerFileStore));
      expect(calls).toEqual([["/sdcard/x.js", "content", false]]);
    })
  );

  it.effect("writeText fails with StorageWriteError when writeFile throws", () =>
    Effect.gen(function* () {
      g.writeFile = () => {
        throw new Error("disk full");
      };
      const error = yield* Effect.gen(function* () {
        const store = yield* FileStore;
        yield* store.writeText("/sdcard/x.js", "content");
      }).pipe(Effect.provide(TaskerFileStore), Effect.flip);
      expect(error._tag).toBe("StorageWriteError");
      expect(error.message).toContain("disk full");
    })
  );

  it.effect("writeText fails with StorageWriteError when writeFile is unavailable", () =>
    Effect.gen(function* () {
      delete g.writeFile;
      const error = yield* Effect.gen(function* () {
        const store = yield* FileStore;
        yield* store.writeText("/sdcard/x.js", "content");
      }).pipe(Effect.provide(TaskerFileStore), Effect.flip);
      expect(error._tag).toBe("StorageWriteError");
    })
  );

  it.effect("writeBytes is not supported on-device", () =>
    Effect.gen(function* () {
      const error = yield* Effect.gen(function* () {
        const store = yield* FileStore;
        yield* store.writeBytes("/sdcard/x.zip", new Uint8Array([1]));
      }).pipe(Effect.provide(TaskerFileStore), Effect.flip);
      expect(error._tag).toBe("StorageWriteError");
      expect(error.message).toContain("Binary writes are not supported");
    })
  );
});

describe("TaskerZipExtractor", () => {
  afterEach(() => {
    delete g.unzip;
  });

  it.effect("extract calls the Tasker unzip builtin", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      g.unzip = (zipPath: string, deleteZipAfter: boolean) => {
        calls.push([zipPath, deleteZipAfter]);
        return true;
      };
      const files = yield* Effect.gen(function* () {
        const extractor = yield* ZipExtractor;
        return yield* extractor.extract("/sdcard/x.zip", "/sdcard/target");
      }).pipe(Effect.provide(TaskerZipExtractor));
      expect(calls).toEqual([["/sdcard/x.zip", true]]);
      expect(files).toEqual([]);
    })
  );

  it.effect("extract fails with ZipExtractError when unzip throws", () =>
    Effect.gen(function* () {
      g.unzip = () => {
        throw new Error("corrupt archive");
      };
      const error = yield* Effect.gen(function* () {
        const extractor = yield* ZipExtractor;
        return yield* extractor.extract("/sdcard/x.zip", "/sdcard/target");
      }).pipe(Effect.provide(TaskerZipExtractor), Effect.flip);
      expect(error._tag).toBe("ZipExtractError");
      expect(error.message).toContain("corrupt archive");
    })
  );

  it.effect("extract fails with ZipExtractError when unzip is unavailable", () =>
    Effect.gen(function* () {
      delete g.unzip;
      const error = yield* Effect.gen(function* () {
        const extractor = yield* ZipExtractor;
        return yield* extractor.extract("/sdcard/x.zip", "/sdcard/target");
      }).pipe(Effect.provide(TaskerZipExtractor), Effect.flip);
      expect(error._tag).toBe("ZipExtractError");
    })
  );
});

describe("pullLatestProfiles (on-device convenience)", () => {
  afterEach(() => {
    delete g.writeFile;
  });

  it.effect("fails off-device with a Tasker-shaped error rather than throwing", () =>
    Effect.gen(function* () {
      // Off-device (no fetch/Tasker globals), the first thing that fails is
      // the HTTP call: this only proves the convenience wiring composes the
      // right layers without needing a real device or network.
      const exit = yield* Effect.exit(pullLatestProfiles({ owner: "a", repo: "b" }));
      expect(exit._tag).toBe("Failure");
    })
  );
});
