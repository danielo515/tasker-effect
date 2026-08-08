/**
 * @module sync
 * @description Module for syncing profiles from GitHub CI artifacts
 */

import { Effect, Context, Layer, Data, Option } from "effect";

// =============================================================================
// Types
// =============================================================================

/** Configuration for the sync module */
export interface SyncConfig {
  readonly owner: string;
  readonly repo: string;
  readonly token?: string;
  readonly artifactPattern?: string;
  readonly targetDir?: string;
  readonly workflow?: string;
  readonly branch?: string;
}

/** Sync errors */
export class SyncError extends Data.TaggedError("SyncError")<{
  readonly message: string;
  readonly cause?: string;
}> {}

export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly message: string;
  readonly statusCode?: number;
}> {}

export class FileSystemError extends Data.TaggedError("FileSystemError")<{
  readonly message: string;
  readonly path: string;
}> {}

/** Artifact metadata */
export interface Artifact {
  readonly id: number;
  readonly name: string;
  readonly sizeInBytes: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly downloadUrl: string;
  readonly workflowRun?: {
    readonly id: number;
    readonly headBranch: string;
    readonly headSha: string;
  };
}

/** Sync result */
export interface SyncResult {
  readonly artifact: Artifact;
  readonly files: readonly string[];
  readonly timestamp: string;
}

// =============================================================================
// GitHub API Types
// =============================================================================

interface GitHubArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  created_at: string;
  expires_at: string;
  archive_download_url: string;
  workflow_run?: {
    id: number;
    head_branch: string;
    head_sha: string;
  };
}

interface GitHubArtifactsResponse {
  total_count: number;
  artifacts: GitHubArtifact[];
}

// =============================================================================
// HTTP Client
// =============================================================================

export interface HttpClientService {
  readonly get: (
    url: string,
    headers?: Record<string, string>
  ) => Effect.Effect<{ status: number; body: string }, NetworkError>;

  readonly download: (
    url: string,
    targetPath: string,
    headers?: Record<string, string>
  ) => Effect.Effect<void, NetworkError | FileSystemError>;
}

export class HttpClient extends Context.Tag("HttpClient")<
  HttpClient,
  HttpClientService
>() {}

/** Node.js HTTP client implementation */
export const NodeHttpClient = Layer.succeed(HttpClient, {
  get: (url, headers = {}) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "tasker-effect",
            ...headers,
          },
        });
        const body = await response.text();
        return { status: response.status, body };
      },
      catch: (e) =>
        new NetworkError({
          message: `HTTP request failed: ${e}`,
        }),
    }),

  download: (url, targetPath, headers = {}) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/octet-stream",
            "User-Agent": "tasker-effect",
            ...headers,
          },
        });

        if (!response.ok) {
          throw new Error(`Download failed: ${response.status}`);
        }

        const buffer = await response.arrayBuffer();

        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { dirname } = await import("node:path");

        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, Buffer.from(buffer));
      },
      catch: (e) =>
        new NetworkError({
          message: `Download failed: ${e}`,
        }),
    }),
});

// =============================================================================
// File System
// =============================================================================

export interface FileSystemService {
  readonly writeFile: (
    path: string,
    content: string
  ) => Effect.Effect<void, FileSystemError>;
  readonly readFile: (path: string) => Effect.Effect<string, FileSystemError>;
  readonly mkdir: (path: string) => Effect.Effect<void, FileSystemError>;
  readonly exists: (path: string) => Effect.Effect<boolean, never>;
  readonly listDir: (path: string) => Effect.Effect<string[], FileSystemError>;
  readonly unzip: (
    zipPath: string,
    targetDir: string
  ) => Effect.Effect<string[], FileSystemError>;
}

export class FileSystem extends Context.Tag("FileSystem")<
  FileSystem,
  FileSystemService
>() {}

/** Node.js file system implementation */
export const NodeFileSystem = Layer.effect(
  FileSystem,
  Effect.gen(function* () {
    const fs = yield* Effect.tryPromise({
      try: () => import("node:fs/promises"),
      catch: () =>
        new FileSystemError({ message: "Failed to import fs", path: "" }),
    });

    const path = yield* Effect.tryPromise({
      try: () => import("node:path"),
      catch: () =>
        new FileSystemError({ message: "Failed to import path", path: "" }),
    });

    return {
      writeFile: (filePath: string, content: string) =>
        Effect.tryPromise({
          try: async () => {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content, "utf-8");
          },
          catch: (e) =>
            new FileSystemError({
              message: `Failed to write file: ${e}`,
              path: filePath,
            }),
        }),

      readFile: (filePath: string) =>
        Effect.tryPromise({
          try: () => fs.readFile(filePath, "utf-8"),
          catch: (e) =>
            new FileSystemError({
              message: `Failed to read file: ${e}`,
              path: filePath,
            }),
        }),

      mkdir: (dirPath: string) =>
        Effect.tryPromise({
          try: () => fs.mkdir(dirPath, { recursive: true }).then(() => undefined),
          catch: (e) =>
            new FileSystemError({
              message: `Failed to create directory: ${e}`,
              path: dirPath,
            }),
        }),

      exists: (filePath: string) =>
        Effect.tryPromise({
          try: async () => {
            try {
              await fs.access(filePath);
              return true;
            } catch {
              return false;
            }
          },
          catch: () => false,
        }).pipe(Effect.orElseSucceed(() => false)),

      listDir: (dirPath: string) =>
        Effect.tryPromise({
          try: () => fs.readdir(dirPath),
          catch: (e) =>
            new FileSystemError({
              message: `Failed to list directory: ${e}`,
              path: dirPath,
            }),
        }),

      unzip: (zipPath: string, targetDir: string) =>
        Effect.tryPromise({
          try: async () => {
            const { execSync } = await import("node:child_process");
            await fs.mkdir(targetDir, { recursive: true });
            execSync(`unzip -o "${zipPath}" -d "${targetDir}"`, {
              stdio: "pipe",
            });
            return fs.readdir(targetDir);
          },
          catch: (e) =>
            new FileSystemError({
              message: `Failed to unzip: ${e}`,
              path: zipPath,
            }),
        }),
    };
  })
);

// =============================================================================
// Sync Service
// =============================================================================

export interface SyncServiceInterface {
  readonly listArtifacts: () => Effect.Effect<
    Artifact[],
    SyncError | NetworkError
  >;
  readonly getLatestArtifact: () => Effect.Effect<
    Option.Option<Artifact>,
    SyncError | NetworkError
  >;
  readonly downloadArtifact: (
    artifact: Artifact
  ) => Effect.Effect<string[], SyncError | NetworkError | FileSystemError>;
  readonly pullLatestProfiles: () => Effect.Effect<
    SyncResult,
    SyncError | NetworkError | FileSystemError
  >;
}

export class SyncService extends Context.Tag("SyncService")<
  SyncService,
  SyncServiceInterface
>() {}

/** Create sync service from config */
export const makeSyncService = (config: SyncConfig) =>
  Layer.effect(
    SyncService,
    Effect.gen(function* () {
      const http = yield* HttpClient;
      const fs = yield* FileSystem;

      const apiUrl = `https://api.github.com/repos/${config.owner}/${config.repo}`;

      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };

      if (config.token) {
        headers.Authorization = `Bearer ${config.token}`;
      }

      const parseArtifact = (ghArtifact: GitHubArtifact): Artifact => ({
        id: ghArtifact.id,
        name: ghArtifact.name,
        sizeInBytes: ghArtifact.size_in_bytes,
        createdAt: ghArtifact.created_at,
        expiresAt: ghArtifact.expires_at,
        downloadUrl: ghArtifact.archive_download_url,
        workflowRun: ghArtifact.workflow_run
          ? {
              id: ghArtifact.workflow_run.id,
              headBranch: ghArtifact.workflow_run.head_branch,
              headSha: ghArtifact.workflow_run.head_sha,
            }
          : undefined,
      });

      return {
        listArtifacts: () =>
          Effect.gen(function* () {
            const response = yield* http.get(
              `${apiUrl}/actions/artifacts`,
              headers
            );

            if (response.status !== 200) {
              return yield* new NetworkError({
                message: `GitHub API returned ${response.status}`,
                statusCode: response.status,
              });
            }

            const data = JSON.parse(response.body) as GitHubArtifactsResponse;

            let artifacts = data.artifacts.filter((a) =>
              a.name.includes(config.artifactPattern ?? "tasker-profiles")
            );

            if (config.branch) {
              artifacts = artifacts.filter(
                (a) => a.workflow_run?.head_branch === config.branch
              );
            }

            return artifacts.map(parseArtifact);
          }),

        getLatestArtifact: () =>
          Effect.gen(function* () {
            const response = yield* http.get(
              `${apiUrl}/actions/artifacts`,
              headers
            );

            if (response.status !== 200) {
              return yield* new NetworkError({
                message: `GitHub API returned ${response.status}`,
                statusCode: response.status,
              });
            }

            const data = JSON.parse(response.body) as GitHubArtifactsResponse;

            let artifacts = data.artifacts.filter((a) =>
              a.name.includes(config.artifactPattern ?? "tasker-profiles")
            );

            if (config.branch) {
              artifacts = artifacts.filter(
                (a) => a.workflow_run?.head_branch === config.branch
              );
            }

            if (artifacts.length === 0) {
              return Option.none<Artifact>();
            }

            const sorted = [...artifacts].sort(
              (a, b) =>
                new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime()
            );

            const first = sorted[0];
            if (!first) {
              return Option.none<Artifact>();
            }
            return Option.some(parseArtifact(first));
          }),

        downloadArtifact: (artifact: Artifact) =>
          Effect.gen(function* () {
            const targetDir = config.targetDir ?? "/sdcard/Tasker/profiles";
            const zipPath = `${targetDir}/_artifact_${artifact.id}.zip`;

            yield* http.download(artifact.downloadUrl, zipPath, headers);
            const files = yield* fs.unzip(zipPath, targetDir);

            return files;
          }),

        pullLatestProfiles: () =>
          Effect.gen(function* () {
            // Get latest artifact inline instead of through service
            const response = yield* http.get(
              `${apiUrl}/actions/artifacts`,
              headers
            );

            if (response.status !== 200) {
              return yield* new NetworkError({
                message: `GitHub API returned ${response.status}`,
                statusCode: response.status,
              });
            }

            const data = JSON.parse(response.body) as GitHubArtifactsResponse;

            let artifacts = data.artifacts.filter((a) =>
              a.name.includes(config.artifactPattern ?? "tasker-profiles")
            );

            if (config.branch) {
              artifacts = artifacts.filter(
                (a) => a.workflow_run?.head_branch === config.branch
              );
            }

            if (artifacts.length === 0) {
              return yield* new SyncError({
                message: "No artifacts found matching criteria",
              });
            }

            const sorted = [...artifacts].sort(
              (a, b) =>
                new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime()
            );

            const first = sorted[0];
            if (!first) {
              return yield* new SyncError({
                message: "No artifacts found matching criteria",
              });
            }

            const artifact = parseArtifact(first);

            // Download artifact inline
            const targetDir = config.targetDir ?? "/sdcard/Tasker/profiles";
            const zipPath = `${targetDir}/_artifact_${artifact.id}.zip`;

            yield* http.download(artifact.downloadUrl, zipPath, headers);
            const files = yield* fs.unzip(zipPath, targetDir);

            return {
              artifact,
              files,
              timestamp: new Date().toISOString(),
            };
          }),
      };
    })
  );

// =============================================================================
// Pre-configured Layers
// =============================================================================

export const NodeSyncLive = (config: SyncConfig) =>
  makeSyncService(config).pipe(
    Layer.provide(NodeHttpClient),
    Layer.provide(NodeFileSystem)
  );

// =============================================================================
// Main Function
// =============================================================================

/**
 * Pull latest profiles from GitHub CI
 */
export const pullLatestProfiles = (options: {
  owner: string;
  repo: string;
  token?: string;
  artifactPattern?: string;
  targetDir?: string;
  branch?: string;
}): Effect.Effect<SyncResult, SyncError | NetworkError | FileSystemError> => {
  const config: SyncConfig = {
    owner: options.owner,
    repo: options.repo,
    token: options.token,
    artifactPattern: options.artifactPattern,
    targetDir: options.targetDir,
    branch: options.branch ?? "main",
  };

  return Effect.gen(function* () {
    const service = yield* SyncService;
    return yield* service.pullLatestProfiles();
  }).pipe(Effect.provide(NodeSyncLive(config)));
};
