import { describe, expect, it } from "@effect/vitest";
import { Command, Error as PlatformError, FileSystem, Path } from "@effect/platform";
import { NodeCommandExecutor, NodeContext, NodePath } from "@effect/platform-node";
import { Effect, Exit, Layer } from "effect";
import {
  FileStoreLive,
  FileStoreNodeLive,
  ZipExtractorLive,
  ZipExtractorNodeLive,
  pullLatestProfiles,
} from "../src/sync/node.js";
import {
  FileStore,
  StorageWriteError,
  ZipExtractor,
  ZipExtractError,
} from "../src/sync/contract.js";

/** A BadArgument PlatformError, as real Node FS operations essentially never raise */
const badArgument = (message: string) =>
  new PlatformError.BadArgument({ module: "FileSystem", method: "test", message });

/** A stub FileSystem whose makeDirectory always fails, merged with a real Path */
const stubFsLayer = (fs: Partial<FileSystem.FileSystem>) =>
  Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop(fs));

const NodeLayer = Layer.mergeAll(NodeContext.layer);

describe("FileStoreNodeLive", () => {
  it.scoped("writeText creates parent directories and writes the file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "tasker-fs-" });
      const target = path.join(dir, "nested", "file.js");

      yield* Effect.gen(function* () {
        const store = yield* FileStore;
        yield* store.writeText(target, "hello");
      }).pipe(Effect.provide(FileStoreNodeLive));

      expect(yield* fs.readFileString(target)).toBe("hello");
    }).pipe(Effect.provide(NodeLayer))
  );

  it.scoped("writeBytes creates parent directories and writes the file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "tasker-fs-" });
      const target = path.join(dir, "nested", "file.bin");

      yield* Effect.gen(function* () {
        const store = yield* FileStore;
        yield* store.writeBytes(target, new Uint8Array([1, 2, 3]));
      }).pipe(Effect.provide(FileStoreNodeLive));

      expect(Array.from(yield* fs.readFile(target))).toEqual([1, 2, 3]);
    }).pipe(Effect.provide(NodeLayer))
  );

  it.scoped(
    "writeText fails with StorageWriteError when the target cannot be created",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "tasker-fs-" });
        // Occupy the path a directory needs to be created at with a file.
        const occupied = path.join(dir, "occupied");
        yield* fs.writeFileString(occupied, "in the way");
        const target = path.join(occupied, "file.js");

        const error = yield* Effect.gen(function* () {
          const store = yield* FileStore;
          yield* store.writeText(target, "hello");
        }).pipe(Effect.provide(FileStoreNodeLive), Effect.flip);

        expect(error).toBeInstanceOf(StorageWriteError);
        expect(error.path).toBe(target);
      }).pipe(Effect.provide(NodeLayer))
  );

  it.scoped(
    "writeBytes fails with StorageWriteError when the target cannot be created",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "tasker-fs-" });
        const occupied = path.join(dir, "occupied");
        yield* fs.writeFileString(occupied, "in the way");
        const target = path.join(occupied, "file.bin");

        const error = yield* Effect.gen(function* () {
          const store = yield* FileStore;
          yield* store.writeBytes(target, new Uint8Array([1]));
        }).pipe(Effect.provide(FileStoreNodeLive), Effect.flip);

        expect(error).toBeInstanceOf(StorageWriteError);
      }).pipe(Effect.provide(NodeLayer))
  );
});

describe("FileStoreLive (BadArgument mapping)", () => {
  it.effect("writeText maps a BadArgument from makeDirectory to StorageWriteError", () =>
    Effect.gen(function* () {
      const store = yield* FileStore;
      const error = yield* store.writeText("/x/y.js", "hi").pipe(Effect.flip);
      expect(error).toBeInstanceOf(StorageWriteError);
    }).pipe(
      Effect.provide(
        FileStoreLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              stubFsLayer({ makeDirectory: () => Effect.fail(badArgument("bad path")) }),
              NodePath.layer
            )
          )
        )
      )
    )
  );

  it.effect("writeBytes maps a BadArgument from makeDirectory to StorageWriteError", () =>
    Effect.gen(function* () {
      const store = yield* FileStore;
      const error = yield* store
        .writeBytes("/x/y.bin", new Uint8Array([1]))
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(StorageWriteError);
    }).pipe(
      Effect.provide(
        FileStoreLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              stubFsLayer({ makeDirectory: () => Effect.fail(badArgument("bad path")) }),
              NodePath.layer
            )
          )
        )
      )
    )
  );
});

describe("ZipExtractorNodeLive", () => {
  it.scoped("extracts a real zip archive's files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "tasker-zip-" });
      const srcDir = path.join(dir, "src");
      yield* fs.makeDirectory(srcDir);
      yield* fs.writeFileString(path.join(srcDir, "a.js"), "// a");
      yield* fs.writeFileString(path.join(srcDir, "b.js"), "// b");
      const zipPath = path.join(dir, "bundle.zip");
      const exitCode = yield* Command.exitCode(
        Command.make("zip", "-j", zipPath, path.join(srcDir, "a.js"), path.join(srcDir, "b.js"))
      );
      expect(exitCode).toBe(0);

      const targetDir = path.join(dir, "out");
      const files = yield* Effect.gen(function* () {
        const extractor = yield* ZipExtractor;
        return yield* extractor.extract(zipPath, targetDir);
      }).pipe(Effect.provide(ZipExtractorNodeLive));

      expect([...files].sort()).toEqual(["a.js", "b.js"]);
      expect(yield* fs.readFileString(path.join(targetDir, "a.js"))).toBe("// a");
    }).pipe(Effect.provide(NodeLayer))
  );

  it.scoped("fails with ZipExtractError when unzip exits non-zero", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "tasker-zip-" });
      const badZip = path.join(dir, "not-a-zip.zip");
      yield* fs.writeFileString(badZip, "this is not a zip file");
      const targetDir = path.join(dir, "out");

      const error = yield* Effect.gen(function* () {
        const extractor = yield* ZipExtractor;
        return yield* extractor.extract(badZip, targetDir);
      }).pipe(Effect.provide(ZipExtractorNodeLive), Effect.flip);

      expect(error).toBeInstanceOf(ZipExtractError);
      expect(error.message).toContain("unzip exited with code");
    }).pipe(Effect.provide(NodeLayer))
  );

  it.scoped(
    "fails with ZipExtractError when the target directory cannot be created",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "tasker-zip-" });
        const occupied = path.join(dir, "occupied");
        yield* fs.writeFileString(occupied, "in the way");
        const targetDir = path.join(occupied, "out");

        const error = yield* Effect.gen(function* () {
          const extractor = yield* ZipExtractor;
          return yield* extractor.extract(path.join(dir, "whatever.zip"), targetDir);
        }).pipe(Effect.provide(ZipExtractorNodeLive), Effect.flip);

        expect(error).toBeInstanceOf(ZipExtractError);
      }).pipe(Effect.provide(NodeLayer))
  );
});

describe("ZipExtractorLive (BadArgument mapping)", () => {
  it.effect(
    "extract maps a BadArgument from makeDirectory to ZipExtractError",
    () => {
      const stubFs = stubFsLayer({
        makeDirectory: () => Effect.fail(badArgument("bad target dir")),
      });
      return Effect.gen(function* () {
        const extractor = yield* ZipExtractor;
        const error = yield* extractor
          .extract("/x/y.zip", "/x/out")
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(ZipExtractError);
      }).pipe(
        Effect.provide(
          ZipExtractorLive.pipe(
            Layer.provide(
              Layer.mergeAll(stubFs, NodeCommandExecutor.layer.pipe(Layer.provide(stubFs)))
            )
          )
        )
      );
    }
  );
});

describe("pullLatestProfiles (Node convenience)", () => {
  it.effect("fails for a repo with no releases rather than throwing", () =>
    Effect.gen(function* () {
      // No mocking here: this exercises the real layer composition
      // (FetchHttpClient + Node FileStore/ZipExtractor). A nonexistent repo
      // guarantees a fast failure without depending on release contents.
      const exit = yield* Effect.exit(
        pullLatestProfiles({ owner: "danielo515", repo: "does-not-exist-xyz" })
      );
      expect(Exit.isFailure(exit)).toBe(true);
    })
  );
});
