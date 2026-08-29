/**
 * @module sync/tasker
 * @description On-device implementations of the sync capabilities, backed by
 * the Tasker builtins, plus `FetchHttpClient` for HTTP (Tasker's WebView has
 * fetch).
 *
 * This module gets bundled for the device: it MUST NOT import
 * @effect/platform-node or any node:* module (a test asserts the bundle
 * stays free of node: specifiers).
 */

import { Effect, Layer } from "effect";
import { Tasker } from "../tasker-api.js";
import {
  FileStore,
  StorageWriteError,
  ZipExtractor,
  ZipExtractError,
  type SyncOptions,
  type FileStoreShape,
  type ZipExtractorShape,
} from "./contract.js";
import { ProfileSync } from "./core.js";

/**
 * FileStore backed by Tasker's writeFile builtin, for running the sync from
 * inside Tasker itself. Binary writes are not supported there.
 */
export const TaskerFileStore: Layer.Layer<FileStore> = Layer.effect(
  FileStore,
  Effect.gen(function* () {
    const tasker = yield* Tasker;
    const store: FileStoreShape = {
      writeText: (path, content) =>
        tasker.writeFile(path, content, false).pipe(
          Effect.filterOrFail(
            (written) => written !== false,
            () =>
              new StorageWriteError({
                message: "Tasker writeFile() returned false",
                path,
              })
          ),
          Effect.asVoid,
          Effect.catchTags({
            TaskerCallError: (error) =>
              Effect.fail(new StorageWriteError({ message: error.message, path })),
            TaskerNotAvailableError: (error) =>
              Effect.fail(new StorageWriteError({ message: error.message, path })),
          })
        ),
      writeBytes: (path) =>
        Effect.fail(
          new StorageWriteError({
            message: "Binary writes are not supported in the Tasker environment",
            path,
          })
        ),
    };
    return store;
  })
).pipe(Layer.provide(Tasker.Default));

/** ZipExtractor backed by Tasker's unzip builtin (extracts in place) */
export const TaskerZipExtractor: Layer.Layer<ZipExtractor> = Layer.effect(
  ZipExtractor,
  Effect.gen(function* () {
    const tasker = yield* Tasker;
    const extractor: ZipExtractorShape = {
      extract: (zipPath, _targetDir) =>
        tasker.unzip(zipPath, true).pipe(
          Effect.flatMap((unzipped) =>
            Effect.fail(
              unzipped === false
                ? new ZipExtractError({
                    message: "Tasker unzip() returned false",
                    path: zipPath,
                  })
                : new ZipExtractError({
                    message: "extracted file list is not observable from Tasker",
                    path: zipPath,
                  })
            )
          ),
          Effect.catchTags({
            TaskerCallError: (error) =>
              Effect.fail(new ZipExtractError({ message: error.message, path: zipPath })),
            TaskerNotAvailableError: (error) =>
              Effect.fail(new ZipExtractError({ message: error.message, path: zipPath })),
          })
        ),
    };
    return extractor;
  })
).pipe(Layer.provide(Tasker.Default));

/**
 * Everything ProfileSync needs for running inside Tasker: fetch-based HTTP
 * plus Tasker-backed file writes and zip extraction.
 */
export const SyncTaskerLive: Layer.Layer<ProfileSync> = ProfileSync.Default.pipe(
  Layer.provide(Layer.mergeAll(TaskerFileStore, TaskerZipExtractor))
);

/**
 * One-shot convenience: pull the latest release assets using the on-device
 * services.
 */
export const pullLatestProfiles = (options: SyncOptions) =>
  ProfileSync.use((sync) => sync.pullLatestProfiles(options)).pipe(
    Effect.provide(SyncTaskerLive)
  );

export { ProfileSync } from "./core.js";
