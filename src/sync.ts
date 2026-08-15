/**
 * @module sync
 * @description Pull compiled JavaScript profiles from GitHub CI.
 *
 * Two sources are supported:
 *
 * - **Releases** (default): downloads the `.js` assets of the latest GitHub
 *   release. Public repos need no token and downloads are plain text, so
 *   this path works both under Node/Bun and inside Tasker's JavaScript
 *   environment (fetch + Tasker's writeFile via {@link TaskerFileStore}).
 * - **Actions artifacts**: downloads the newest CI artifact zip via the
 *   GitHub API (token required) and extracts it. Intended for Node/CI use.
 */

import { Effect, Layer, Schema } from "effect";
import { Tasker } from "./tasker-api.js";

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

const ReleaseAsset = Schema.Struct({
  name: Schema.String,
  browser_download_url: Schema.String,
  size: Schema.Number,
});

const Release = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(ReleaseAsset),
});

const Artifact = Schema.Struct({
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

const ArtifactsResponse = Schema.Struct({
  artifacts: Schema.Array(Artifact),
});

/** Metadata of a CI artifact */
export type ArtifactInfo = typeof Artifact.Type;

// =============================================================================
// HTTP client service (fetch-based; works in Node, Bun and modern WebViews)
// =============================================================================

const fetchResponse = (
  url: string,
  headers: Record<string, string>
): Effect.Effect<Response, DownloadError> =>
  Effect.tryPromise({
    try: () => fetch(url, { headers }),
    catch: (cause) => new DownloadError({ message: String(cause), url }),
  });

export class SyncHttpClient extends Effect.Service<SyncHttpClient>()(
  "SyncHttpClient",
  {
    sync: () => {
      const getJson = Effect.fn("SyncHttpClient.getJson")(function* (
        url: string,
        headers: Record<string, string>
      ) {
        const response = yield* fetchResponse(url, headers).pipe(
          Effect.catchTag("DownloadError", (error) =>
            Effect.fail(
              new GitHubApiError({ message: error.message, url })
            )
          )
        );
        if (!response.ok) {
          return yield* Effect.fail(
            new GitHubApiError({
              message: `GitHub API returned ${response.status}`,
              url,
              status: response.status,
            })
          );
        }
        return yield* Effect.tryPromise({
          try: (): Promise<unknown> => response.json(),
          catch: (cause) =>
            new GitHubApiError({ message: `Invalid JSON: ${String(cause)}`, url }),
        });
      });

      const getText = Effect.fn("SyncHttpClient.getText")(function* (
        url: string,
        headers: Record<string, string>
      ) {
        const response = yield* fetchResponse(url, headers);
        if (!response.ok) {
          return yield* Effect.fail(
            new DownloadError({
              message: `Download returned ${response.status}`,
              url,
            })
          );
        }
        return yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) => new DownloadError({ message: String(cause), url }),
        });
      });

      const getBytes = Effect.fn("SyncHttpClient.getBytes")(function* (
        url: string,
        headers: Record<string, string>
      ) {
        const response = yield* fetchResponse(url, headers);
        if (!response.ok) {
          return yield* Effect.fail(
            new DownloadError({
              message: `Download returned ${response.status}`,
              url,
            })
          );
        }
        const buffer = yield* Effect.tryPromise({
          try: () => response.arrayBuffer(),
          catch: (cause) => new DownloadError({ message: String(cause), url }),
        });
        return new Uint8Array(buffer);
      });

      return { getJson, getText, getBytes };
    },
  }
) {}

// =============================================================================
// File store service
// =============================================================================

export class FileStore extends Effect.Service<FileStore>()("FileStore", {
  sync: () => ({
    /** Write a text file, creating parent directories (Node/Bun) */
    writeText: (path: string, content: string): Effect.Effect<void, StorageWriteError> =>
      Effect.tryPromise({
        try: async () => {
          const fs = await import("node:fs/promises");
          const { dirname } = await import("node:path");
          await fs.mkdir(dirname(path), { recursive: true });
          await fs.writeFile(path, content, "utf-8");
        },
        catch: (cause) =>
          new StorageWriteError({ message: String(cause), path }),
      }),
    /** Write a binary file, creating parent directories (Node/Bun) */
    writeBytes: (path: string, content: Uint8Array): Effect.Effect<void, StorageWriteError> =>
      Effect.tryPromise({
        try: async () => {
          const fs = await import("node:fs/promises");
          const { dirname } = await import("node:path");
          await fs.mkdir(dirname(path), { recursive: true });
          await fs.writeFile(path, content);
        },
        catch: (cause) =>
          new StorageWriteError({ message: String(cause), path }),
      }),
  }),
}) {}

/**
 * FileStore backed by Tasker's writeFile builtin, for running the sync from
 * inside Tasker itself. Binary writes are not supported there.
 */
export const TaskerFileStore: Layer.Layer<FileStore> = Layer.effect(
  FileStore,
  Effect.gen(function* () {
    const tasker = yield* Tasker;
    return new FileStore({
      writeText: (path: string, content: string) =>
        tasker.writeFile(path, content, false).pipe(
          Effect.asVoid,
          Effect.catchTags({
            TaskerCallError: (error) =>
              Effect.fail(new StorageWriteError({ message: error.message, path })),
            TaskerNotAvailableError: (error) =>
              Effect.fail(new StorageWriteError({ message: error.message, path })),
          })
        ),
      writeBytes: (path: string) =>
        Effect.fail(
          new StorageWriteError({
            message: "Binary writes are not supported in the Tasker environment",
            path,
          })
        ),
    });
  })
).pipe(Layer.provide(Tasker.Default));

// =============================================================================
// Zip extractor service
// =============================================================================

export class ZipExtractor extends Effect.Service<ZipExtractor>()(
  "ZipExtractor",
  {
    sync: () => ({
      /** Extract a zip into a directory, returning the extracted file names */
      extract: (
        zipPath: string,
        targetDir: string
      ): Effect.Effect<ReadonlyArray<string>, ZipExtractError> =>
        Effect.tryPromise({
          try: async () => {
            const { execFileSync } = await import("node:child_process");
            const fs = await import("node:fs/promises");
            await fs.mkdir(targetDir, { recursive: true });
            execFileSync("unzip", ["-o", zipPath, "-d", targetDir], {
              stdio: "pipe",
            });
            return await fs.readdir(targetDir);
          },
          catch: (cause) =>
            new ZipExtractError({ message: String(cause), path: zipPath }),
        }),
    }),
  }
) {}

/** ZipExtractor backed by Tasker's unzip builtin (extracts in place) */
export const TaskerZipExtractor: Layer.Layer<ZipExtractor> = Layer.effect(
  ZipExtractor,
  Effect.gen(function* () {
    const tasker = yield* Tasker;
    return new ZipExtractor({
      extract: (zipPath: string, _targetDir: string) =>
        tasker.unzip(zipPath, true).pipe(
          Effect.as([] as ReadonlyArray<string>),
          Effect.catchTags({
            TaskerCallError: (error) =>
              Effect.fail(new ZipExtractError({ message: error.message, path: zipPath })),
            TaskerNotAvailableError: (error) =>
              Effect.fail(new ZipExtractError({ message: error.message, path: zipPath })),
          })
        ),
    });
  })
).pipe(Layer.provide(Tasker.Default));

// =============================================================================
// Profile sync service
// =============================================================================

/** Options for a sync run */
export interface SyncOptions {
  readonly owner: string;
  readonly repo: string;
  /** Where to store the downloaded files. Default: /sdcard/Tasker/js */
  readonly targetDir?: string;
  /** GitHub token; required for artifact downloads and private repos */
  readonly token?: string;
  /** File suffixes to download from release assets. Default: [".js"] */
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

const DEFAULT_TARGET_DIR = "/sdcard/Tasker/js";

const apiHeaders = (token: string | undefined): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "tasker-effect",
  ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
});

const decodeAs = <A, I>(schema: Schema.Schema<A, I>, url: string) =>
  (input: unknown): Effect.Effect<A, GitHubApiError> =>
    Schema.decodeUnknown(schema)(input).pipe(
      Effect.catchTag("ParseError", (error) =>
        Effect.fail(
          new GitHubApiError({
            message: `Unexpected GitHub API payload: ${error.message}`,
            url,
          })
        )
      )
    );

export class ProfileSync extends Effect.Service<ProfileSync>()("ProfileSync", {
  dependencies: [
    SyncHttpClient.Default,
    FileStore.Default,
    ZipExtractor.Default,
  ],
  effect: Effect.gen(function* () {
    const http = yield* SyncHttpClient;
    const files = yield* FileStore;
    const extractor = yield* ZipExtractor;

    /** Pull the .js assets of the latest release. Works on-device. */
    const pullLatestProfiles = Effect.fn("ProfileSync.pullLatestProfiles")(
      function* (options: SyncOptions) {
        const targetDir = options.targetDir ?? DEFAULT_TARGET_DIR;
        const suffixes = options.assetSuffixes ?? [".js"];
        const url = `https://api.github.com/repos/${options.owner}/${options.repo}/releases/latest`;

        const payload = yield* http.getJson(url, apiHeaders(options.token));
        const release = yield* decodeAs(Release, url)(payload);

        const assets = release.assets.filter((asset) =>
          suffixes.some((suffix) => asset.name.endsWith(suffix))
        );
        if (assets.length === 0) {
          return yield* Effect.fail(
            new NothingToSyncError({
              message: `Release ${release.tag_name} has no assets matching ${suffixes.join(", ")}`,
            })
          );
        }

        const written: Array<string> = [];
        for (const asset of assets) {
          const content = yield* http.getText(
            asset.browser_download_url,
            apiHeaders(options.token)
          );
          const path = `${targetDir}/${asset.name}`;
          yield* files.writeText(path, content);
          written.push(asset.name);
          yield* Effect.log("Synced release asset", { asset: asset.name, path });
        }

        return {
          source: "release",
          version: release.tag_name,
          files: written,
          targetDir,
        } satisfies SyncResult;
      }
    );

    /** Newest non-expired CI artifact matching the configured name */
    const latestArtifact = Effect.fn("ProfileSync.latestArtifact")(function* (
      options: SyncOptions
    ) {
      const name = options.artifactName ?? "tasker-js";
      const url = `https://api.github.com/repos/${options.owner}/${options.repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=10`;

      const payload = yield* http.getJson(url, apiHeaders(options.token));
      const response = yield* decodeAs(ArtifactsResponse, url)(payload);

      const candidates = response.artifacts
        .filter((artifact) => !artifact.expired)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));

      const newest = candidates[0];
      if (newest === undefined) {
        return yield* Effect.fail(
          new NothingToSyncError({
            message: `No CI artifact named "${name}" found`,
          })
        );
      }
      return newest;
    });

    /** Download and extract the newest CI artifact zip. Node/CI only. */
    const pullFromArtifacts = Effect.fn("ProfileSync.pullFromArtifacts")(
      function* (options: SyncOptions) {
        if (options.token === undefined) {
          return yield* Effect.fail(
            new GitHubApiError({
              message: "A GitHub token is required to download CI artifacts",
              url: "https://api.github.com/actions/artifacts",
            })
          );
        }
        const targetDir = options.targetDir ?? DEFAULT_TARGET_DIR;
        const artifact = yield* latestArtifact(options);

        const bytes = yield* http.getBytes(
          artifact.archive_download_url,
          apiHeaders(options.token)
        );
        const zipPath = `${targetDir}/${artifact.name}.zip`;
        yield* files.writeBytes(zipPath, bytes);
        const extracted = yield* extractor.extract(zipPath, targetDir);

        return {
          source: "artifact",
          version: artifact.created_at,
          files: extracted,
          targetDir,
        } satisfies SyncResult;
      }
    );

    return { pullLatestProfiles, latestArtifact, pullFromArtifacts };
  }),
}) {}

/**
 * Layer for running the sync from inside Tasker: fetch-based HTTP plus
 * Tasker-backed file writes and zip extraction.
 */
export const TaskerProfileSyncLive: Layer.Layer<ProfileSync> =
  ProfileSync.DefaultWithoutDependencies.pipe(
    Layer.provide(SyncHttpClient.Default),
    Layer.provide(TaskerFileStore),
    Layer.provide(TaskerZipExtractor)
  );

/**
 * One-shot convenience: pull the latest release assets using the default
 * (Node/Bun) services.
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
  }).pipe(Effect.provide(ProfileSync.Default));
