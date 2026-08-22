import { beforeAll, describe, expect, it } from "@effect/vitest";
import { Command, FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer, Stream } from "effect";
import { Action, Task } from "../src/profile.js";
import { TaskerCompiler } from "../src/compiler.js";
import { FileStore } from "../src/sync/node.js";
import {
  asCompilable,
  collectCompilables,
  compileEntry,
  parseGitHubRepo,
} from "../src/cli.js";
import * as fixture from "./fixtures/cli-entry.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const FIXTURE_ENTRY = new URL("./fixtures/cli-entry.ts", import.meta.url)
  .pathname;
const EMPTY_ENTRY = new URL("./fixtures/cli-empty.ts", import.meta.url).pathname;

const CliTestLayer = Layer.mergeAll(
  TaskerCompiler.Default,
  FileStore.Default,
  NodeContext.layer
);

describe("parseGitHubRepo", () => {
  it.each([
    ["git@github.com:acme/automations.git"],
    ["git@github.com:acme/automations"],
    ["https://github.com/acme/automations.git"],
    ["https://github.com/acme/automations"],
    ["https://github.com/acme/automations/"],
    ["http://github.com/acme/automations"],
    ["ssh://git@github.com/acme/automations.git"],
    ["  https://github.com/acme/automations.git\n"],
  ])("normalizes %s", (url) => {
    expect(parseGitHubRepo(url)).toEqual({ owner: "acme", repo: "automations" });
  });

  it("keeps dots and dashes in names", () => {
    expect(parseGitHubRepo("git@github.com:my-org/my.repo-2.git")).toEqual({
      owner: "my-org",
      repo: "my.repo-2",
    });
  });

  it("rejects non-GitHub and malformed URLs", () => {
    expect(parseGitHubRepo("git@gitlab.com:acme/automations.git")).toBeUndefined();
    expect(parseGitHubRepo("https://example.com/acme/automations")).toBeUndefined();
    expect(parseGitHubRepo("acme/automations")).toBeUndefined();
    expect(parseGitHubRepo("")).toBeUndefined();
  });
});

describe("export scanning", () => {
  it("collects default and named Project/Profile/Task exports", () => {
    const found = collectCompilables(fixture as Record<string, unknown>);
    const names = found.map((entry) => entry.exportName).sort();
    expect(names).toEqual(["default", "greet", "nightMode"]);
  });

  it("ignores non-DSL exports", () => {
    expect(asCompilable("a string")).toBeUndefined();
    expect(asCompilable({ name: "close", but: "no" })).toBeUndefined();
    expect(asCompilable(undefined)).toBeUndefined();
  });

  it("accepts structurally-matching plain objects (cross-realm instances)", () => {
    const plain = JSON.parse(
      JSON.stringify(new Task({ name: "Alien", actions: [Action.flash("hi")] }))
    );
    const recovered = asCompilable(plain);
    expect(recovered).toBeInstanceOf(Task);
    expect((recovered as Task).name).toBe("Alien");
  });
});

describe("compileEntry", () => {
  it.scoped("compiles every export of the fixture into the output dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outDir = yield* fs.makeTempDirectoryScoped({
        prefix: "tasker-effect-cli-",
      });

      const result = yield* compileEntry({
        entry: FIXTURE_ENTRY,
        outDir,
        repo: { owner: "acme", repo: "automations" },
      });

      expect(result.exports.sort()).toEqual(["default", "greet", "nightMode"]);
      const filenames = result.files.map((file) => file.filename).sort();
      expect(filenames).toEqual([
        "README.md",
        "dispatcher.js",
        "greet.js",
        "night-mode.enter.js",
        "night-mode.exit.js",
        "project-task.js",
        "secrets.json",
        "tasker-effect.prj.xml",
      ]);
      for (const file of result.files) {
        const exists = yield* fs.exists(path.join(outDir, file.filename));
        expect(exists).toBe(true);
      }
      const greet = yield* fs.readFileString(path.join(outDir, "greet.js"));
      expect(greet).toContain('flash("Hi");');
      expect(greet).toContain('"use strict";');
      const projectXml = yield* fs.readFileString(
        path.join(outDir, "tasker-effect.prj.xml")
      );
      expect(projectXml).toContain(
        "https://github.com/acme/automations/releases/download/"
      );
    }).pipe(Effect.provide(CliTestLayer))
  );

  it.scoped("fails with EntryNotFoundError for a missing entry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outDir = yield* fs.makeTempDirectoryScoped({
        prefix: "tasker-effect-cli-",
      });
      const error = yield* compileEntry({
        entry: "does/not/exist.ts",
        outDir,
      }).pipe(Effect.flip);
      expect(error._tag).toBe("EntryNotFoundError");
    }).pipe(Effect.provide(CliTestLayer))
  );

  it.scoped("fails with NoCompilableExportsError for an entry without DSL exports", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outDir = yield* fs.makeTempDirectoryScoped({
        prefix: "tasker-effect-cli-",
      });
      const error = yield* compileEntry({ entry: EMPTY_ENTRY, outDir }).pipe(
        Effect.flip
      );
      expect(error._tag).toBe("NoCompilableExportsError");
    }).pipe(Effect.provide(CliTestLayer))
  );
});

describe("CLI end-to-end (spawned)", () => {
  // The bin shim requires the built dist (no source fallback): build first,
  // then run it under plain Node — exactly what a consumer install does.
  beforeAll(
    () =>
      Effect.runPromise(
        Command.exitCode(
          Command.make("bun", "run", "build").pipe(
            Command.workingDirectory(REPO_ROOT)
          )
        ).pipe(
          Effect.filterOrDieMessage(
            (code) => code === 0,
            "bun run build failed; the spawned CLI tests need dist/cli.js"
          ),
          Effect.asVoid,
          Effect.provide(NodeContext.layer)
        )
      ),
    120_000
  );

  const runCliProcess = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Spawned with bun (matching `bunx tasker-effect`): the CLI supports
        // TypeScript entry modules only under the Bun runtime.
        const process = yield* Command.start(
          Command.make("bun", "bin/tasker-effect.mjs", ...args).pipe(
            Command.workingDirectory(REPO_ROOT)
          )
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(process.stdout)),
            Stream.mkString(Stream.decodeText(process.stderr)),
            process.exitCode,
          ],
          { concurrency: 3 }
        );
        return { stdout, stderr, exitCode };
      })
    ).pipe(Effect.provide(NodeContext.layer));

  it.effect(
    "--help prints usage and exits 0",
    () =>
      Effect.gen(function* () {
        const { stdout, exitCode } = yield* runCliProcess(["--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("compile");
        expect(stdout).toContain("esbuild");
      }),
    30_000
  );

  it.effect(
    "no arguments prints help and exits 0",
    () =>
      Effect.gen(function* () {
        const { stdout, exitCode } = yield* runCliProcess([]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("compile");
      }),
    30_000
  );

  it.effect(
    "compile --help documents the options",
    () =>
      Effect.gen(function* () {
        const { stdout, exitCode } = yield* runCliProcess(["compile", "--help"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("--out");
        expect(stdout).toContain("--repo");
        expect(stdout).toContain("tasks/automations.ts");
      }),
    30_000
  );

  it.effect(
    "rejects a malformed --repo with exit code 1",
    () =>
      Effect.gen(function* () {
        const { stderr, exitCode } = yield* runCliProcess([
          "compile",
          "--repo",
          "not-a-slug",
        ]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain(
          "--repo requires a GitHub repository as <owner>/<name>"
        );
      }),
    30_000
  );

  it.scoped(
    "compiles a fixture entry to the requested output dir",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outDir = yield* fs.makeTempDirectoryScoped({
          prefix: "tasker-effect-cli-",
        });
        const { stdout, stderr, exitCode } = yield* runCliProcess([
          "compile",
          FIXTURE_ENTRY,
          "--out",
          outDir,
          "--repo",
          "acme/automations",
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Compiled 3 export(s)");
        expect(stdout).toContain("8 file(s) written");
        expect(yield* fs.exists(path.join(outDir, "greet.js"))).toBe(true);
        expect(
          yield* fs.exists(path.join(outDir, "night-mode.enter.js"))
        ).toBe(true);
        expect(yield* fs.exists(path.join(outDir, "README.md"))).toBe(true);
      }).pipe(Effect.provide(NodeContext.layer)),
    30_000
  );

  it.effect(
    "exits non-zero with a helpful message when the entry is missing",
    () =>
      Effect.gen(function* () {
        const { stderr, exitCode } = yield* runCliProcess([
          "compile",
          "no/such/entry.ts",
        ]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("Entry module not found");
      }),
    30_000
  );

  it.effect(
    "exits non-zero when the entry has no compilable exports",
    () =>
      Effect.gen(function* () {
        const { stderr, exitCode } = yield* runCliProcess(["compile", EMPTY_ENTRY]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("no compilable exports");
      }),
    30_000
  );
});
