import { describe, expect, test } from "bun:test";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Layer } from "effect";
import {
  FileStore,
  ProfileSync,
  StorageWriteError,
  ZipExtractor,
  type SyncOptions,
} from "../src/sync.js";

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
}) => {
  const written = new Map<string, string | Uint8Array>();
  const extractedInto: Array<string> = [];

  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const url = request.url;
      const respond = (body: Response) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, body));

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
          new Response(JSON.stringify(artifacts), {
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
    Layer.provide(httpLayer),
    Layer.provide(fileLayer),
    Layer.provide(zipLayer)
  );

  return { layer, written, extractedInto };
};

const baseOptions: SyncOptions = {
  owner: "danielo515",
  repo: "tasker-effect",
  targetDir: "/tmp/tasker-js",
};

describe("ProfileSync.pullLatestProfiles (release source)", () => {
  test("downloads .js assets and writes them to the target dir", async () => {
    const { layer, written } = makeStubs();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(Effect.provide(layer))
    );

    expect(result.source).toBe("release");
    expect(result.version).toBe("v1.2.0");
    expect(result.files).toEqual(["morning-routine.js"]);
    expect(written.get("/tmp/tasker-js/morning-routine.js")).toContain(
      "morning-routine.js"
    );
    expect(written.has("/tmp/tasker-js/README.md")).toBe(false);
  });

  test("honours custom asset suffixes", async () => {
    const { layer, written } = makeStubs();

    await Effect.runPromise(
      Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles({
          ...baseOptions,
          assetSuffixes: [".js", ".md"],
        });
      }).pipe(Effect.provide(layer))
    );

    expect(written.has("/tmp/tasker-js/README.md")).toBe(true);
  });

  test("fails with NothingToSyncError when no assets match", async () => {
    const { layer } = makeStubs({
      releaseJson: { tag_name: "v0.0.1", assets: [] },
    });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(Effect.provide(layer), Effect.flip)
    );

    expect(error._tag).toBe("NothingToSyncError");
  });

  test("fails with GitHubApiError on malformed payloads", async () => {
    const { layer } = makeStubs({ releaseJson: { nope: true } });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(Effect.provide(layer), Effect.flip)
    );

    expect(error._tag).toBe("GitHubApiError");
  });

  test("maps non-2xx API responses to GitHubApiError with the status", async () => {
    const { layer } = makeStubs({ releaseStatus: 500 });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullLatestProfiles(baseOptions);
      }).pipe(Effect.provide(layer), Effect.flip)
    );

    expect(error._tag).toBe("GitHubApiError");
    expect(error._tag === "GitHubApiError" && error.status).toBe(500);
  });
});

describe("ProfileSync artifacts source", () => {
  test("latestArtifact picks the newest non-expired artifact", async () => {
    const { layer } = makeStubs();

    const artifact = await Effect.runPromise(
      Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.latestArtifact({ ...baseOptions, token: "t" });
      }).pipe(Effect.provide(layer))
    );

    expect(artifact.id).toBe(2);
  });

  test("pullFromArtifacts requires a token", async () => {
    const { layer } = makeStubs();

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullFromArtifacts(baseOptions);
      }).pipe(Effect.provide(layer), Effect.flip)
    );

    expect(error._tag).toBe("GitHubApiError");
  });

  test("pullFromArtifacts downloads the zip and extracts it", async () => {
    const { layer, written, extractedInto } = makeStubs();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sync = yield* ProfileSync;
        return yield* sync.pullFromArtifacts({ ...baseOptions, token: "t" });
      }).pipe(Effect.provide(layer))
    );

    expect(result.source).toBe("artifact");
    expect(result.files).toEqual(["a.js", "b.js"]);
    expect(written.has("/tmp/tasker-js/tasker-js.zip")).toBe(true);
    expect(extractedInto).toEqual([
      "/tmp/tasker-js/tasker-js.zip -> /tmp/tasker-js",
    ]);
  });
});

describe("error types", () => {
  test("StorageWriteError carries the failing path", () => {
    const error = new StorageWriteError({ message: "disk full", path: "/x" });
    expect(error._tag).toBe("StorageWriteError");
    expect(error.path).toBe("/x");
  });
});
