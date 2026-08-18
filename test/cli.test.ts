import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Layer } from "effect";
import { Action, Task } from "../src/profile.js";
import { TaskerCompiler } from "../src/compiler.js";
import { FileStore } from "../src/sync/node.js";
import {
  asCompilable,
  collectCompilables,
  compileEntry,
  parseCliArgs,
  parseGitHubRepo,
} from "../src/cli.js";
import * as fixture from "./fixtures/cli-entry.js";

const REPO_ROOT = join(import.meta.dir, "..");
const FIXTURE_ENTRY = join(import.meta.dir, "fixtures", "cli-entry.ts");
const EMPTY_ENTRY = join(import.meta.dir, "fixtures", "cli-empty.ts");

const CliTestLayer = Layer.mergeAll(TaskerCompiler.Default, FileStore.Default);

const tempDirs: Array<string> = [];
const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "tasker-effect-cli-"));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("parseCliArgs", () => {
  test("no args means help", () => {
    expect(Either.getOrThrow(parseCliArgs([]))).toEqual({ _tag: "Help" });
    expect(Either.getOrThrow(parseCliArgs(["--help"]))).toEqual({ _tag: "Help" });
  });

  test("compile with defaults", () => {
    expect(Either.getOrThrow(parseCliArgs(["compile"]))).toEqual({
      _tag: "Compile",
      entry: undefined,
      outDir: "dist-tasker",
      repo: undefined,
    });
  });

  test("compile with entry and --out", () => {
    expect(
      Either.getOrThrow(parseCliArgs(["compile", "my/entry.ts", "--out", "build"]))
    ).toEqual({
      _tag: "Compile",
      entry: "my/entry.ts",
      outDir: "build",
      repo: undefined,
    });
  });

  test("--repo overrides repo detection", () => {
    expect(
      Either.getOrThrow(parseCliArgs(["compile", "--repo", "acme/automations"]))
    ).toEqual({
      _tag: "Compile",
      entry: undefined,
      outDir: "dist-tasker",
      repo: { owner: "acme", repo: "automations" },
    });
  });

  test("rejects unknown commands and options", () => {
    expect(Either.isLeft(parseCliArgs(["frobnicate"]))).toBe(true);
    expect(Either.isLeft(parseCliArgs(["compile", "--wat"]))).toBe(true);
    expect(Either.isLeft(parseCliArgs(["compile", "--out"]))).toBe(true);
    expect(Either.isLeft(parseCliArgs(["compile", "a.ts", "b.ts"]))).toBe(true);
    expect(Either.isLeft(parseCliArgs(["compile", "--repo"]))).toBe(true);
    expect(Either.isLeft(parseCliArgs(["compile", "--repo", "not-a-slug"]))).toBe(
      true
    );
    expect(
      Either.isLeft(parseCliArgs(["compile", "--repo", "too/many/parts"]))
    ).toBe(true);
  });
});

describe("parseGitHubRepo", () => {
  test.each([
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

  test("keeps dots and dashes in names", () => {
    expect(parseGitHubRepo("git@github.com:my-org/my.repo-2.git")).toEqual({
      owner: "my-org",
      repo: "my.repo-2",
    });
  });

  test("rejects non-GitHub and malformed URLs", () => {
    expect(parseGitHubRepo("git@gitlab.com:acme/automations.git")).toBeUndefined();
    expect(parseGitHubRepo("https://example.com/acme/automations")).toBeUndefined();
    expect(parseGitHubRepo("acme/automations")).toBeUndefined();
    expect(parseGitHubRepo("")).toBeUndefined();
  });
});

describe("export scanning", () => {
  test("collects default and named Project/Profile/Task exports", () => {
    const found = collectCompilables(fixture as Record<string, unknown>);
    const names = found.map((entry) => entry.exportName).sort();
    expect(names).toEqual(["default", "greet", "nightMode"]);
  });

  test("ignores non-DSL exports", () => {
    expect(asCompilable("a string")).toBeUndefined();
    expect(asCompilable({ name: "close", but: "no" })).toBeUndefined();
    expect(asCompilable(undefined)).toBeUndefined();
  });

  test("accepts structurally-matching plain objects (cross-realm instances)", () => {
    const plain = JSON.parse(
      JSON.stringify(new Task({ name: "Alien", actions: [Action.flash("hi")] }))
    );
    const recovered = asCompilable(plain);
    expect(recovered).toBeInstanceOf(Task);
    expect((recovered as Task).name).toBe("Alien");
  });
});

describe("compileEntry", () => {
  const run = <A, E>(effect: Effect.Effect<A, E, TaskerCompiler | FileStore>) =>
    Effect.runPromise(effect.pipe(Effect.provide(CliTestLayer)) as Effect.Effect<A, E>);

  test("compiles every export of the fixture into the output dir", async () => {
    const outDir = makeTempDir();
    const result = await run(
      compileEntry({
        entry: FIXTURE_ENTRY,
        outDir,
        repo: { owner: "acme", repo: "automations" },
      })
    );

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
      expect(existsSync(join(outDir, file.filename))).toBe(true);
    }
    const greet = readFileSync(join(outDir, "greet.js"), "utf-8");
    expect(greet).toContain('flash("Hi");');
    expect(greet).toContain('"use strict";');
    const projectXml = readFileSync(join(outDir, "tasker-effect.prj.xml"), "utf-8");
    expect(projectXml).toContain(
      "https://github.com/acme/automations/releases/download/"
    );
  });

  test("fails with EntryNotFoundError for a missing entry", async () => {
    const error = await run(
      compileEntry({ entry: "does/not/exist.ts", outDir: makeTempDir() }).pipe(
        Effect.flip
      )
    );
    expect(error._tag).toBe("EntryNotFoundError");
  });

  test("fails with NoCompilableExportsError for an entry without DSL exports", async () => {
    const error = await run(
      compileEntry({ entry: EMPTY_ENTRY, outDir: makeTempDir() }).pipe(Effect.flip)
    );
    expect(error._tag).toBe("NoCompilableExportsError");
  });
});

describe("CLI end-to-end (spawned)", () => {
  const runCliProcess = async (args: Array<string>) => {
    const proc = Bun.spawn(["bun", "bin/tasker-effect.mjs", ...args], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  };

  test("--help prints usage and exits 0", async () => {
    const { stdout, exitCode } = await runCliProcess(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("tasker-effect compile [entry] [--out <dir>]");
    expect(stdout).toContain("esbuild");
  });

  test("compiles a fixture entry to the requested output dir", async () => {
    const outDir = makeTempDir();
    const { stdout, stderr, exitCode } = await runCliProcess([
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
    expect(existsSync(join(outDir, "greet.js"))).toBe(true);
    expect(existsSync(join(outDir, "night-mode.enter.js"))).toBe(true);
    expect(existsSync(join(outDir, "README.md"))).toBe(true);
  });

  test("exits non-zero with a helpful message when the entry is missing", async () => {
    const { stderr, exitCode } = await runCliProcess([
      "compile",
      "no/such/entry.ts",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Entry module not found");
  });

  test("exits non-zero when the entry has no compilable exports", async () => {
    const { stderr, exitCode } = await runCliProcess(["compile", EMPTY_ENTRY]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no compilable exports");
  });
});
