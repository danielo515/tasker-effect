/**
 * @module sync/node
 * @description Desktop (Node/Bun) implementations of the sync capabilities,
 * built on @effect/platform + @effect/platform-node. This is the only sync
 * module allowed to import @effect/platform-node or node:* — everything for
 * the device lives in sync/tasker.ts.
 *
 * HTTP uses `FetchHttpClient` rather than NodeHttpClient: fetch is built into
 * Node ≥18 and Bun, it keeps the exact same client implementation as the
 * on-device path, and undici's extras (agents, proxies, socket tuning) buy
 * nothing for a couple of GitHub API calls.
 */

import {
  Command,
  CommandExecutor,
  FetchHttpClient,
  FileSystem,
  Path,
} from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import {
  FileStore as FileStoreTag,
  StorageWriteError,
  ZipExtractor as ZipExtractorTag,
  ZipExtractError,
  type SyncOptions,
  type SyncResult,
  type FileStoreShape,
  type ZipExtractorShape,
} from "./contract.js";
import { ProfileSync } from "./core.js";
import type { DownloadError, GitHubApiError, NothingToSyncError } from "./contract.js";

/** FileStore backed by `FileSystem`/`Path`, undecided which implementation */
export const FileStoreLive: Layer.Layer<
  FileStoreTag,
  never,
  FileSystem.FileSystem | Path.Path
> = Layer.effect(
  FileStoreTag,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const storageErrors = (target: string) => ({
      SystemError: (error: { readonly message: string }) =>
        Effect.fail(new StorageWriteError({ message: error.message, path: target })),
      BadArgument: (error: { readonly message: string }) =>
        Effect.fail(new StorageWriteError({ message: error.message, path: target })),
    });

    return {
      writeText: (target, content) =>
        fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(target, content)),
          Effect.catchTags(storageErrors(target))
        ),
      writeBytes: (target, content) =>
        fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
          Effect.andThen(fs.writeFile(target, content)),
          Effect.catchTags(storageErrors(target))
        ),
    } satisfies FileStoreShape;
  })
);

/** FileStore backed by @effect/platform's FileSystem (Node/Bun) */
export const FileStoreNodeLive: Layer.Layer<FileStoreTag> = FileStoreLive.pipe(
  Layer.provide(NodeContext.layer)
);

/** ZipExtractor backed by `FileSystem`/`CommandExecutor`, undecided which implementation */
export const ZipExtractorLive: Layer.Layer<
  ZipExtractorTag,
  never,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> = Layer.effect(
  ZipExtractorTag,
  Effect.gen(function* () {
    const context = yield* Effect.context<CommandExecutor.CommandExecutor>();
    const fs = yield* FileSystem.FileSystem;

    return {
      extract: (zipPath, targetDir) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(targetDir, { recursive: true });
          const exitCode = yield* Command.exitCode(
            Command.make("unzip", "-o", zipPath, "-d", targetDir)
          );
          if (exitCode !== 0) {
            return yield* new ZipExtractError({
              message: `unzip exited with code ${exitCode}`,
              path: zipPath,
            });
          }
          return (yield* fs.readDirectory(targetDir)) as ReadonlyArray<string>;
        }).pipe(
          Effect.catchTags({
            SystemError: (error) =>
              Effect.fail(
                new ZipExtractError({ message: error.message, path: zipPath })
              ),
            BadArgument: (error) =>
              Effect.fail(
                new ZipExtractError({ message: error.message, path: zipPath })
              ),
          }),
          Effect.provide(context)
        ),
    } satisfies ZipExtractorShape;
  })
);

/** ZipExtractor running the system `unzip` via @effect/platform's Command */
export const ZipExtractorNodeLive: Layer.Layer<ZipExtractorTag> = ZipExtractorLive.pipe(
  Layer.provide(NodeContext.layer)
);

/**
 * Compatibility service classes: same tags as the contract, with a `.Default`
 * layer pointing at the Node implementation so existing `FileStore.Default`
 * call sites (CLI, compile scripts) keep working.
 */
export class FileStore extends FileStoreTag {
  static readonly Default: Layer.Layer<FileStoreTag> = FileStoreNodeLive;
}

export class ZipExtractor extends ZipExtractorTag {
  static readonly Default: Layer.Layer<ZipExtractorTag> = ZipExtractorNodeLive;
}

/** Everything ProfileSync needs, desktop edition */
export const SyncNodeLive: Layer.Layer<ProfileSync> = ProfileSync.Default.pipe(
  Layer.provide(
    Layer.mergeAll(FetchHttpClient.layer, FileStoreNodeLive, ZipExtractorNodeLive)
  )
);

/**
 * One-shot convenience: pull the latest release assets using the Node/Bun
 * services.
 */
export const pullLatestProfiles = (
  options: SyncOptions
): Effect.Effect<
  SyncResult,
  GitHubApiError | DownloadError | NothingToSyncError | StorageWriteError
> =>
  Effect.gen(function* () {
    const sync = yield* ProfileSync;
    return yield* sync.pullLatestProfiles(options);
  }).pipe(Effect.provide(SyncNodeLive));
