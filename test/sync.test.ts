import { describe, expect, it } from "@effect/vitest";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Effect, Layer } from "effect";
import {
  DownloadError,
  FileStore,
  GitHubApiError,
  NothingToSyncError,
  StorageWriteError,
  ZipExtractor,
  type SyncOptions,
} from "../src/sync/contract.js";
import { ProfileSync } from "../src/sync/core.js";

const release = {
  tag_name: "v1.2.0",
  assets: [
    {
      name: "morning-routine.js",
      browser_download_url: "https://example.com/morning-routine.js",
      size: 100,
    },
    {
      name: "README.md",
      browser_download_url: "https://example.com/README.md",
      size: 50,
    },
  ],
};

const artifacts = {
  artifacts: [
    {
      id: 1,
      name: "tasker-js",
      size_in_bytes: 10,
      created_at: "2026-08-01T00:00:00Z",
      expired: false,
      archive_download_url: "https://example.com/artifact-1.zip",
    },
    {
      id: 2,
      name: "tasker-js",
      size_in_bytes: 10,
      created_at: "2026-08-10T00:00:00Z",
      expired: false,
      archive_download_url: "https://example.com/artifact-2.zip",
    },
    {
      id: 3,
      name: "tasker-js",
      size_in_bytes: 10,
      created_at: "2026-08-12T00:00:00Z",
      expired: true,
      archive_download_url: "https://example.com/artifact-3.zip",
    },
  ],
};

const makeStubs = (options?: {
  readonly releaseJson?: unknown;
  readonly releaseStatus?: number;
  readonly artifactsJson?: unknown;
  readonly failTransport?: "api" | "download";
}) => {
  const written = new Map<string, string | Uint8Array>();
  const extractedInto: Array<string> = [];

  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const url = request.url;
      const respond = (body: Response) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, body));

      if (
        options?.failTransport === "api" &&
        (url.includes("/releases/latest") || url.includes("/actions/artifacts"))
      ) {
        return Effect.fail(
          new HttpClientError.RequestError({
            request: HttpClientRequest.get(url),
            reason: "Transport",
            cause: new Error("connection refused"),
          })
        );
      }
      if (
        options?.failTransport === "download" &&
        !url.includes("/releases/latest") &&
        !url.includes("/actions/artifacts")
      ) {
        return Effect.fail(
          new HttpClientError.RequestError({
            request: HttpClientRequest.get(url),
            reason: "Transport",
            cause: new Error("connection refused"),
          })
        );
      }

      if (url.includes("/releases/latest")) {
        return respond(
          new Response(JSON.stringify(options?.releaseJson ?? release), {
            status: options?.releaseStatus ?? 200,
            headers: { "content-type": "application/json" },
          })
        );
      }
      if (url.includes("/actions/artifacts")) {
        return respond(
          new Response(JSON.stringify(options?.artifactsJson ?? artifacts), {
            headers: { "content-type": "application/json" },
          })
        );
      }
      if (url.endsWith(".zip")) {
        return respond(new Response(new Uint8Array([80, 75])));
      }
      return respond(new Response(`// contents of ${url}`));
    })
  );

  const fileLayer = Layer.succeed(FileStore, {
    writeText: (path: string, content: string) =>
      Effect.sync(() => {
        written.set(path, content);
      }),
    writeBytes: (path: string, content: Uint8Array) =>
      Effect.sync(() => {
        written.set(path, content);
      }),
  });

  const zipLayer = Layer.succeed(ZipExtractor, {
    extract: (zipPath: string, targetDir: string) =>
      Effect.sync(() => {
        extractedInto.push(`${zipPath} -> ${targetDir}`);
        return ["a.js", "b.js"] as ReadonlyArray<string>;
      }),
  });

  const layer = ProfileSync.Default.pipe(
    Layer.provide(Layer.mergeAll(httpLayer, fileLayer, zipLayer))
  );

  return { layer, written, extractedInto };
};

const baseOptions: SyncOptions = {
  owner: "danielo515",
  repo: "tasker-effect",
  targetDir: "/tmp/tasker-js",
};

describe("ProfileSync.pullLatestProfiles (release source)", () => {
  it.effect("downloads .js assets and writes them to the target dir", () =>
    Effect.gen(function* () {
      const { layer, written } = makeStubs();

      const result = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(Effect.provide(layer));

      expect(result.source).toBe("release");
      expect(result.version).toBe("v1.2.0");
      expect(result.files).toEqual(["morning-routine.js"]);
      expect(written.get("/tmp/tasker-js/morning-routine.js")).toContain(
        "morning-routine.js"
      );
      expect(written.has("/tmp/tasker-js/README.md")).toBe(false);
    })
  );

  it.effect("syncs .json and .prj.xml assets (secrets manifest, project XML) by default", () =>
    Effect.gen(function* () {
      const { layer, written } = makeStubs({
        releaseJson: {
          tag_name: "v1.3.0",
          assets: [
            ...release.assets,
            {
              name: "secrets.json",
              browser_download_url: "https://example.com/secrets.json",
              size: 20,
            },
            {
              name: "tasker-effect.prj.xml",
              browser_download_url: "https://example.com/tasker-effect.prj.xml",
              size: 30,
            },
          ],
        },
      });

      const result = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(Effect.provide(layer));

      expect(result.files.sort()).toEqual([
        "morning-routine.js",
        "secrets.json",
        "tasker-effect.prj.xml",
      ]);
      expect(written.has("/tmp/tasker-js/secrets.json")).toBe(true);
      expect(written.has("/tmp/tasker-js/tasker-effect.prj.xml")).toBe(true);
      expect(written.has("/tmp/tasker-js/README.md")).toBe(false);
    })
  );

  it.effect("honours custom asset suffixes", () =>
    Effect.gen(function* () {
      const { layer, written } = makeStubs();

      yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles({
          ...baseOptions,
          assetSuffixes: [".js", ".md"],
        });
      }).pipe(Effect.provide(layer));

      expect(written.has("/tmp/tasker-js/README.md")).toBe(true);
    })
  );

  it.effect("fails with NothingToSyncError when no assets match", () =>
    Effect.gen(function* () {
      const { layer } = makeStubs({
        releaseJson: { tag_name: "v0.0.1", assets: [] },
      });

      const error = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(NothingToSyncError);
    })
  );

  it.effect("defaults targetDir when not provided", () =>
    Effect.gen(function* () {
      const { layer, written } = makeStubs();

      yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles({
          owner: baseOptions.owner,
          repo: baseOptions.repo,
        });
      }).pipe(Effect.provide(layer));

      expect(written.has("/sdcard/Tasker/js/morning-routine.js")).toBe(true);
    })
  );

  it.effect("maps a non-2xx asset download to DownloadError with the status", () =>
    Effect.gen(function* () {
      const overrideHttp = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const respond = (body: Response) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, body));
          if (request.url.includes("/releases/latest")) {
            return respond(
              new Response(JSON.stringify(release), {
                headers: { "content-type": "application/json" },
              })
            );
          }
          return respond(new Response("not found", { status: 404 }));
        })
      );

      const error = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(
        Effect.provide(
          ProfileSync.Default.pipe(
            Layer.provide(
              Layer.mergeAll(
                overrideHttp,
                Layer.succeed(FileStore, {
                  writeText: () => Effect.void,
                  writeBytes: () => Effect.void,
                }),
                Layer.succeed(ZipExtractor, { extract: () => Effect.succeed([]) })
              )
            )
          )
        ),
        Effect.flip
      );

      expect(error).toBeInstanceOf(DownloadError);
      expect(error.message).toContain("Download returned 404");
    })
  );

  it.effect("maps a non-status-code API response failure to GitHubApiError", () =>
    Effect.gen(function* () {
      const brokenStream = new ReadableStream({
        start(controller) {
          controller.error(new Error("json stream exploded"));
        },
      });
      const overrideHttp = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(brokenStream)))
        )
      );

      const error = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(
        Effect.provide(
          ProfileSync.Default.pipe(
            Layer.provide(
              Layer.mergeAll(
                overrideHttp,
                Layer.succeed(FileStore, {
                  writeText: () => Effect.void,
                  writeBytes: () => Effect.void,
                }),
                Layer.succeed(ZipExtractor, { extract: () => Effect.succeed([]) })
              )
            )
          )
        ),
        Effect.flip
      );

      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error instanceof GitHubApiError && error.status).toBeUndefined();
    })
  );

  it.effect("fails with GitHubApiError on malformed payloads", () =>
    Effect.gen(function* () {
      const { layer } = makeStubs({ releaseJson: { nope: true } });

      const error = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(GitHubApiError);
    })
  );

  it.effect("maps a transport failure fetching the release JSON to GitHubApiError", () =>
    Effect.gen(function* () {
      const { layer } = makeStubs({ failTransport: "api" });

      const error = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error instanceof GitHubApiError && error.message).toContain(
        "Transport error"
      );
    })
  );

  it.effect("maps a transport failure downloading an asset to DownloadError", () =>
    Effect.gen(function* () {
      const { layer } = makeStubs({ failTransport: "download" });

      const error = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(DownloadError);
    })
  );

  it.effect("maps a non-status-code download failure to DownloadError", () =>
    Effect.gen(function* () {
      const brokenStream = new ReadableStream({
        start(controller) {
          controller.error(new Error("stream exploded"));
        },
      });
      const overrideHttp = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          if (request.url.includes("/releases/latest")) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify(release), {
                  headers: { "content-type": "application/json" },
                })
              )
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(brokenStream))
          );
        })
      );

      const error = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(
        Effect.provide(
          ProfileSync.Default.pipe(
            Layer.provide(
              Layer.mergeAll(
                overrideHttp,
                Layer.succeed(FileStore, {
                  writeText: () => Effect.void,
                  writeBytes: () => Effect.void,
                }),
                Layer.succeed(ZipExtractor, { extract: () => Effect.succeed([]) })
              )
            )
          )
        ),
        Effect.flip
      );

      expect(error).toBeInstanceOf(DownloadError);
      expect(error.message).not.toContain("Download returned");
    })
  );

  it.effect("maps non-2xx API responses to GitHubApiError with the status", () =>
    Effect.gen(function* () {
      const { layer } = makeStubs({ releaseStatus: 500 });

      const error = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error instanceof GitHubApiError && error.status).toBe(500);
    })
  );
});

describe("ProfileSync artifacts source", () => {
  it.effect("latestArtifact picks the newest non-expired artifact", () =>
    Effect.gen(function* () {
      const { layer } = makeStubs();

      const artifact = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.latestArtifact({ ...baseOptions, token: "t" });
      }).pipe(Effect.provide(layer));

      expect(artifact.id).toBe(2);
    })
  );

  it.effect("latestArtifact fails with NothingToSyncError when none match", () =>
    Effect.gen(function* () {
      const { layer } = makeStubs({ artifactsJson: { artifacts: [] } });

      const error = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.latestArtifact({
          ...baseOptions,
          token: "t",
          artifactName: "no-such-artifact",
        });
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(NothingToSyncError);
      expect(error.message).toContain("no-such-artifact");
    })
  );

  it.effect("pullFromArtifacts requires a token", () =>
    Effect.gen(function* () {
      const { layer } = makeStubs();

      const error = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullFromArtifacts(baseOptions);
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(GitHubApiError);
    })
  );

  it.effect("pullFromArtifacts defaults targetDir when not provided", () =>
    Effect.gen(function* () {
      const { layer, written } = makeStubs();

      yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullFromArtifacts({
          owner: baseOptions.owner,
          repo: baseOptions.repo,
          token: "t",
        });
      }).pipe(Effect.provide(layer));

      expect(written.has("/sdcard/Tasker/js/tasker-js.zip")).toBe(true);
    })
  );

  it.effect("pullFromArtifacts downloads the zip and extracts it", () =>
    Effect.gen(function* () {
      const { layer, written, extractedInto } = makeStubs();

      const result = yield* Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullFromArtifacts({ ...baseOptions, token: "t" });
      }).pipe(Effect.provide(layer));

      expect(result.source).toBe("artifact");
      expect(result.files).toEqual(["a.js", "b.js"]);
      expect(written.has("/tmp/tasker-js/tasker-js.zip")).toBe(true);
      expect(extractedInto).toEqual([
        "/tmp/tasker-js/tasker-js.zip -> /tmp/tasker-js",
      ]);
    })
  );
});

describe("error types", () => {
  it("StorageWriteError carries the failing path", () => {
    const error = new StorageWriteError({ message: "disk full", path: "/x" });
    expect(error._tag).toBe("StorageWriteError");
    expect(error.path).toBe("/x");
  });
});
