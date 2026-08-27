/**
 * @module sync/core
 * @description The platform-agnostic sync program.
 *
 * `ProfileSync` is written against @effect/platform's `HttpClient` (whose
 * interface carries no platform code) plus our own `FileStore` and
 * `ZipExtractor` capabilities. Its `Default` layer deliberately *requires*
 * those services instead of baking implementations in — provide them with
 * `SyncNodeLive` (sync/node.ts) or `SyncTaskerLive` (sync/tasker.ts).
 *
 * Two sources are supported:
 *
 * - **Releases** (default): downloads the `.js`/`.json`/`.prj.xml` assets of
 *   the latest GitHub release. Public repos need no token and downloads are
 *   plain text, so this path works both under Node/Bun and inside Tasker.
 * - **Actions artifacts**: downloads the newest CI artifact zip via the
 *   GitHub API (token required) and extracts it. Intended for Node/CI use.
 */

import { HttpClient } from "@effect/platform";
import { Effect, Schema } from "effect";
import {
  ArtifactsResponse,
  DEFAULT_ASSET_SUFFIXES,
  DEFAULT_TARGET_DIR,
  DownloadError,
  FileStore,
  GitHubApiError,
  NothingToSyncError,
  Release,
  ZipExtractor,
  type SyncOptions,
  type SyncResult,
} from "./contract.js";

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
  effect: Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk
    );
    const files = yield* FileStore;
    const extractor = yield* ZipExtractor;

    const getJson = (url: string, token: string | undefined) =>
      client.get(url, { headers: apiHeaders(token) }).pipe(
        Effect.flatMap((response) => response.json),
        Effect.catchTags({
          RequestError: (error) =>
            Effect.fail(new GitHubApiError({ message: error.message, url })),
          ResponseError: (error) =>
            Effect.fail(
              error.reason === "StatusCode"
                ? new GitHubApiError({
                    message: `GitHub API returned ${error.response.status}`,
                    url,
                    status: error.response.status,
                  })
                : new GitHubApiError({ message: error.message, url })
            ),
        })
      );

    const downloadErrors = (url: string) => ({
      RequestError: (error: { readonly message: string }) =>
        Effect.fail(new DownloadError({ message: error.message, url })),
      ResponseError: (error: {
        readonly message: string;
        readonly reason: string;
        readonly response: { readonly status: number };
      }) =>
        Effect.fail(
          new DownloadError({
            message:
              error.reason === "StatusCode"
                ? `Download returned ${error.response.status}`
                : error.message,
            url,
          })
        ),
    });

    const getText = (url: string, token: string | undefined) =>
      client.get(url, { headers: apiHeaders(token) }).pipe(
        Effect.flatMap((response) => response.text),
        Effect.catchTags(downloadErrors(url))
      );

    const getBytes = (url: string, token: string | undefined) =>
      client.get(url, { headers: apiHeaders(token) }).pipe(
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.catchTags(downloadErrors(url))
      );

    /** Pull the matching assets of the latest release. Works on-device. */
    const pullLatestProfiles = Effect.fn("ProfileSync.pullLatestProfiles")(
      function* (options: SyncOptions) {
        const targetDir = options.targetDir ?? DEFAULT_TARGET_DIR;
        const suffixes = options.assetSuffixes ?? DEFAULT_ASSET_SUFFIXES;
        const url = `https://api.github.com/repos/${options.owner}/${options.repo}/releases/latest`;

        const payload = yield* getJson(url, options.token);
        const release = yield* decodeAs(Release, url)(payload);

        const assets = release.assets.filter((asset) =>
          suffixes.some((suffix) => asset.name.endsWith(suffix))
        );
        if (assets.length === 0) {
          return yield* new NothingToSyncError({
            message: `Release ${release.tag_name} has no assets matching ${suffixes.join(", ")}`,
          });
        }

        const written: Array<string> = [];
        for (const asset of assets) {
          const content = yield* getText(
            asset.browser_download_url,
            options.token
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

      const payload = yield* getJson(url, options.token);
      const response = yield* decodeAs(ArtifactsResponse, url)(payload);

      const candidates = response.artifacts
        .filter((artifact) => !artifact.expired)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));

      const newest = candidates[0];
      if (newest === undefined) {
        return yield* new NothingToSyncError({
          message: `No CI artifact named "${name}" found`,
        });
      }
      return newest;
    });

    /** Download and extract the newest CI artifact zip. Node/CI only. */
    const pullFromArtifacts = Effect.fn("ProfileSync.pullFromArtifacts")(
      function* (options: SyncOptions) {
        if (options.token === undefined) {
          return yield* new GitHubApiError({
            message: "A GitHub token is required to download CI artifacts",
            url: "https://api.github.com/actions/artifacts",
          });
        }
        const targetDir = options.targetDir ?? DEFAULT_TARGET_DIR;
        const artifact = yield* latestArtifact(options);

        const bytes = yield* getBytes(
          artifact.archive_download_url,
          options.token
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
