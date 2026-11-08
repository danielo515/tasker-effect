import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import {
  TaskerFileStore,
  TaskerZipExtractor,
  percentSafeChunks,
  pullLatestProfiles,
} from "../src/sync/tasker.js";
import {
  FileStore,
  StorageWriteError,
  ZipExtractor,
  ZipExtractError,
} from "../src/sync/contract.js";

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
    }),
  );

  it.effect(
    "writeText survives Tasker's %variable expansion byte for byte",
    () =>
      Effect.gen(function* () {
        // Fake writeFile that expands set variables like Tasker does.
        const vars: Record<string, string> = {
          CLIP: "line 1\nline 2",
          caller1: "task=TE Sync",
        };
        let file = "";
        g.writeFile = (_path: string, text: string, append: boolean) => {
          const expanded = text.replace(
            /%([A-Za-z][A-Za-z0-9_]{2,})/g,
            (whole, name: string) => (name in vars ? vars[name]! : whole),
          );
          file = append ? file + expanded : expanded;
          return true;
        };
        const content =
          '// %CLIP is a fallback; %caller1 too\nvar pct = "100%"; a %% b %\n';
        yield* Effect.gen(function* () {
          const store = yield* FileStore;
          yield* store.writeText("/sdcard/x.js", content);
        }).pipe(Effect.provide(TaskerFileStore));
        expect(file).toBe(content);
      }),
  );

  it("percentSafeChunks splits right after every %", () => {
    expect(percentSafeChunks("")).toEqual([""]);
    expect(percentSafeChunks("abc")).toEqual(["abc"]);
    expect(percentSafeChunks("a %CLIP b")).toEqual(["a %", "CLIP b"]);
    expect(percentSafeChunks("%%x%")).toEqual(["%", "%", "x%"]);
  });

  it.effect(
    "writeText fails with StorageWriteError when writeFile throws",
    () =>
      Effect.gen(function* () {
        g.writeFile = () => {
          throw new Error("disk full");
        };
        const error = yield* Effect.gen(function* () {
          const store = yield* FileStore;
          yield* store.writeText("/sdcard/x.js", "content");
        }).pipe(Effect.provide(TaskerFileStore), Effect.flip);
        expect(error).toBeInstanceOf(StorageWriteError);
        expect(error.message).toContain("disk full");
      }),
  );

  it.effect(
    "writeText fails with StorageWriteError when writeFile is unavailable",
    () =>
      Effect.gen(function* () {
        delete g.writeFile;
        const error = yield* Effect.gen(function* () {
          const store = yield* FileStore;
          yield* store.writeText("/sdcard/x.js", "content");
        }).pipe(Effect.provide(TaskerFileStore), Effect.flip);
        expect(error).toBeInstanceOf(StorageWriteError);
      }),
  );

  it.effect(
    "writeText fails with StorageWriteError when writeFile returns false (refused)",
    () =>
      Effect.gen(function* () {
        g.writeFile = () => false;
        const error = yield* Effect.gen(function* () {
          const store = yield* FileStore;
          yield* store.writeText("/sdcard/x.js", "content");
        }).pipe(Effect.provide(TaskerFileStore), Effect.flip);
        expect(error).toBeInstanceOf(StorageWriteError);
        expect(error.message).toContain("returned false");
      }),
  );

  it.effect("writeBytes is not supported on-device", () =>
    Effect.gen(function* () {
      const error = yield* Effect.gen(function* () {
        const store = yield* FileStore;
        yield* store.writeBytes("/sdcard/x.zip", new Uint8Array([1]));
      }).pipe(Effect.provide(TaskerFileStore), Effect.flip);
      expect(error).toBeInstanceOf(StorageWriteError);
      expect(error.message).toContain("Binary writes are not supported");
    }),
  );
});

describe("TaskerZipExtractor", () => {
  afterEach(() => {
    delete g.unzip;
  });

  it.effect(
    "extract calls the Tasker unzip builtin, but the extracted file list is not observable",
    () =>
      Effect.gen(function* () {
        const calls: Array<unknown> = [];
        g.unzip = (zipPath: string, deleteZipAfter: boolean) => {
          calls.push([zipPath, deleteZipAfter]);
          return true;
        };
        const error = yield* Effect.gen(function* () {
          const extractor = yield* ZipExtractor;
          return yield* extractor.extract("/sdcard/x.zip", "/sdcard/target");
        }).pipe(Effect.provide(TaskerZipExtractor), Effect.flip);
        expect(calls).toEqual([["/sdcard/x.zip", true]]);
        expect(error).toBeInstanceOf(ZipExtractError);
        expect(error.message).toContain("not observable");
      }),
  );

  it.effect(
    "extract fails with ZipExtractError when unzip returns false (refused)",
    () =>
      Effect.gen(function* () {
        g.unzip = () => false;
        const error = yield* Effect.gen(function* () {
          const extractor = yield* ZipExtractor;
          return yield* extractor.extract("/sdcard/x.zip", "/sdcard/target");
        }).pipe(Effect.provide(TaskerZipExtractor), Effect.flip);
        expect(error).toBeInstanceOf(ZipExtractError);
        expect(error.message).toContain("returned false");
      }),
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
      expect(error).toBeInstanceOf(ZipExtractError);
      expect(error.message).toContain("corrupt archive");
    }),
  );

  it.effect(
    "extract fails with ZipExtractError when unzip is unavailable",
    () =>
      Effect.gen(function* () {
        delete g.unzip;
        const error = yield* Effect.gen(function* () {
          const extractor = yield* ZipExtractor;
          return yield* extractor.extract("/sdcard/x.zip", "/sdcard/target");
        }).pipe(Effect.provide(TaskerZipExtractor), Effect.flip);
        expect(error).toBeInstanceOf(ZipExtractError);
      }),
  );
});

describe("pullLatestProfiles (on-device convenience)", () => {
  afterEach(() => {
    delete g.writeFile;
  });

  it.effect(
    "fails off-device with a Tasker-shaped error rather than throwing",
    () =>
      Effect.gen(function* () {
        // Off-device (no fetch/Tasker globals), the first thing that fails is
        // the HTTP call: this only proves the convenience wiring composes the
        // right layers without needing a real device or network.
        const exit = yield* Effect.exit(
          pullLatestProfiles({ owner: "a", repo: "b" }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }),
  );
});
