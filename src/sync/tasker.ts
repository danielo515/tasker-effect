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

import { FetchHttpClient } from "@effect/platform";
import { Effect, Layer } from "effect";
import { Tasker } from "../tasker-api.js";
import {
  FileStore,
  StorageWriteError,
  ZipExtractor,
  ZipExtractError,
  type SyncOptions,
  type SyncResult,
  type FileStoreShape,
  type ZipExtractorShape,
} from "./contract.js";
import type {
  DownloadError,
  GitHubApiError,
  NothingToSyncError,
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
          Effect.as([] as ReadonlyArray<string>),
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
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(TaskerFileStore),
  Layer.provide(TaskerZipExtractor)
);

/**
 * One-shot convenience: pull the latest release assets using the on-device
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
  }).pipe(Effect.provide(SyncTaskerLive));

export { ProfileSync } from "./core.js";
