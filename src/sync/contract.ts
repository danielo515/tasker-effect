/**
 * @module sync/contract
 * @description Platform-free surface of the profile sync: error types,
 * options/result shapes, GitHub API payload schemas and the two small
 * capability services the sync program needs from its host platform.
 *
 * `FileStore` and `ZipExtractor` are ours (rather than @effect/platform's
 * `FileSystem`) because Tasker's JavaScript environment cannot implement the
 * full `FileSystem` interface — it can only write text files and unzip in
 * place. Keep them minimal.
 */

import { Context, Effect, Schema } from "effect";

// =============================================================================
// Errors
// =============================================================================

/** The GitHub API answered with an error or unparseable payload */
export class GitHubApiError extends Schema.TaggedError<GitHubApiError>()(
  "GitHubApiError",
  {
    message: Schema.String,
    url: Schema.String,
    status: Schema.optional(Schema.Number),
  }
) {}

/** A file download failed */
export class DownloadError extends Schema.TaggedError<DownloadError>()(
  "DownloadError",
  {
    message: Schema.String,
    url: Schema.String,
  }
) {}

/** No matching release asset or CI artifact was found */
export class NothingToSyncError extends Schema.TaggedError<NothingToSyncError>()(
  "NothingToSyncError",
  {
    message: Schema.String,
  }
) {}

/** Writing a synced file to storage failed */
export class StorageWriteError extends Schema.TaggedError<StorageWriteError>()(
  "StorageWriteError",
  {
    message: Schema.String,
    path: Schema.String,
  }
) {}

/** Extracting a downloaded artifact zip failed */
export class ZipExtractError extends Schema.TaggedError<ZipExtractError>()(
  "ZipExtractError",
  {
    message: Schema.String,
    path: Schema.String,
  }
) {}

// =============================================================================
// GitHub API payload schemas
// =============================================================================

export const ReleaseAsset = Schema.Struct({
  name: Schema.String,
  browser_download_url: Schema.String,
  size: Schema.Number,
});

export const Release = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(ReleaseAsset),
});

export const Artifact = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  size_in_bytes: Schema.Number,
  created_at: Schema.String,
  expired: Schema.Boolean,
  archive_download_url: Schema.String,
  workflow_run: Schema.optional(
    Schema.Struct({
      head_branch: Schema.optional(Schema.String),
    })
  ),
});

export const ArtifactsResponse = Schema.Struct({
  artifacts: Schema.Array(Artifact),
});

/** Metadata of a CI artifact */
export type ArtifactInfo = typeof Artifact.Type;

// =============================================================================
// Options / result
// =============================================================================

/** Options for a sync run */
export interface SyncOptions {
  readonly owner: string;
  readonly repo: string;
  /** Where to store the downloaded files. Default: /sdcard/Tasker/js */
  readonly targetDir?: string;
  /** GitHub token; required for artifact downloads and private repos */
  readonly token?: string;
  /**
   * File suffixes to download from release assets.
   * Default: {@link DEFAULT_ASSET_SUFFIXES}
   */
  readonly assetSuffixes?: ReadonlyArray<string>;
  /** CI artifact name to look for. Default: "tasker-js" */
  readonly artifactName?: string;
}

/** Result of a sync run */
export interface SyncResult {
  readonly source: "release" | "artifact";
  /** Release tag or artifact created_at that was synced */
  readonly version: string;
  readonly files: ReadonlyArray<string>;
  readonly targetDir: string;
}

export const DEFAULT_TARGET_DIR = "/sdcard/Tasker/js";

/**
 * Release-asset suffixes synced by default: compiled JS, the `secrets.json`
 * manifest, and the importable `tasker-effect.prj.xml`. The XML is inert on
 * disk (Tasker only reads it during a manual import), but keeping the current
 * copy next to the JS means scaffolding updates are a re-import away — no
 * manual download.
 */
export const DEFAULT_ASSET_SUFFIXES: ReadonlyArray<string> = [
  ".js",
  ".json",
  ".prj.xml",
];

// =============================================================================
// Platform capability services
// =============================================================================

export interface FileStoreShape {
  /** Write a text file, creating parent directories where supported */
  readonly writeText: (
    path: string,
    content: string
  ) => Effect.Effect<void, StorageWriteError>;
  /** Write a binary file, creating parent directories where supported */
  readonly writeBytes: (
    path: string,
    content: Uint8Array
  ) => Effect.Effect<void, StorageWriteError>;
}

/**
 * Minimal file-writing capability. Implementations: `FileStoreNodeLive`
 * (@effect/platform FileSystem) and `TaskerFileStore` (Tasker builtins).
 */
export class FileStore extends Context.Tag("FileStore")<
  FileStore,
  FileStoreShape
>() {}

export interface ZipExtractorShape {
  /** Extract a zip into a directory, returning the extracted file names */
  readonly extract: (
    zipPath: string,
    targetDir: string
  ) => Effect.Effect<ReadonlyArray<string>, ZipExtractError>;
}

/**
 * Minimal zip-extraction capability. Implementations: `ZipExtractorNodeLive`
 * (@effect/platform Command running `unzip`) and `TaskerZipExtractor`
 * (Tasker's unzip builtin).
 */
export class ZipExtractor extends Context.Tag("ZipExtractor")<
  ZipExtractor,
  ZipExtractorShape
>() {}
