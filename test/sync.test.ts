import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  ProfileSync,
  SyncHttpClient,
  FileStore,
  ZipExtractor,
  StorageWriteError,
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

const makeStubs = (options?: { readonly releaseJson?: unknown }) => {
  const written = new Map<string, string | Uint8Array>();
  const extractedInto: Array<string> = [];

  const httpLayer = Layer.succeed(
    SyncHttpClient,
    new SyncHttpClient({
      getJson: (url: string) =>
        Effect.succeed(
          url.includes("/releases/latest")
            ? (options?.releaseJson ?? release)
            : artifacts
        ),
      getText: (url: string) => Effect.succeed(`// contents of ${url}`),
      getBytes: () => Effect.succeed(new Uint8Array([80, 75])),
    })
  );

  const fileLayer = Layer.succeed(
    FileStore,
    new FileStore({
      writeText: (path: string, content: string) =>
        Effect.sync(() => {
          written.set(path, content);
        }),
      writeBytes: (path: string, content: Uint8Array) =>
        Effect.sync(() => {
          written.set(path, content);
        }),
    })
  );

  const zipLayer = Layer.succeed(
    ZipExtractor,
    new ZipExtractor({
      extract: (zipPath: string, targetDir: string) =>
        Effect.sync(() => {
          extractedInto.push(`${zipPath} -> ${targetDir}`);
          return ["a.js", "b.js"] as ReadonlyArray<string>;
        }),
    })
  );

  const layer = ProfileSync.DefaultWithoutDependencies.pipe(
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
