import { beforeAll, describe, expect, it } from "@effect/vitest";
import { Command, CommandExecutor, FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Chunk, Effect, Layer, Stream } from "effect";
import { Action, Profile, Project, Task, Trigger } from "../src/profile.js";
import { CompileError, TaskerCompiler } from "../src/compiler.js";
import { FileStore } from "../src/sync/node.js";
import { StorageWriteError } from "../src/sync/contract.js";
import {
  asCompilable,
  collectCompilables,
  compileEntry,
  detectRepoFromGit,
  EntryImportError,
  EntryNotFoundError,
  formatCliError,
  NoCompilableExportsError,
  parseGitHubRepo,
  RepoDetectionError,
  runCli,
} from "../src/cli.js";
import * as fixture from "./fixtures/cli-entry.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const FIXTURE_ENTRY = new URL("./fixtures/cli-entry.ts", import.meta.url)
  .pathname;
const EMPTY_ENTRY = new URL("./fixtures/cli-empty.ts", import.meta.url).pathname;
const THROWS_ENTRY = new URL("./fixtures/cli-throws.ts", import.meta.url)
  .pathname;
const THROWS_JS_ENTRY = new URL("./fixtures/cli-throws.js", import.meta.url)
  .pathname;
const COLLISION_ENTRY = new URL("./fixtures/cli-collision.ts", import.meta.url)
  .pathname;
const BROKEN_LINK_ENTRY = new URL(
  "./fixtures/cli-broken-link.ts",
  import.meta.url
).pathname;

const CliTestLayer = Layer.mergeAll(
  TaskerCompiler.Default,
  FileStore.Default,
  NodeContext.layer
);

/** A fake CommandExecutor that never spawns a real process, for testing `git` interactions */
const fakeCommandExecutorLayer = (options: {
  readonly stdout?: string;
  readonly exitCode: number;
}): Layer.Layer<CommandExecutor.CommandExecutor> =>
  Layer.succeed(
    CommandExecutor.CommandExecutor,
    CommandExecutor.makeExecutor(() =>
      Effect.succeed({
        [CommandExecutor.ProcessTypeId]: CommandExecutor.ProcessTypeId,
        pid: CommandExecutor.ProcessId(1),
        exitCode: Effect.succeed(CommandExecutor.ExitCode(options.exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stderr: Stream.empty,
        stdin: undefined as never,
        stdout: Stream.fromChunk(
          Chunk.of(new TextEncoder().encode(options.stdout ?? ""))
        ),
        toJSON: () => ({ _id: "FakeProcess" }),
        toString: () => "FakeProcess",
        [Symbol.for("nodejs.util.inspect.custom")]: () => "FakeProcess",
      } as unknown as CommandExecutor.Process)
    )
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

  it("accepts a structurally-matching plain Profile", () => {
    const plain = JSON.parse(
      JSON.stringify(
        new Profile({
          name: "Alien Profile",
          triggers: [Trigger.wifiConnected()],
          enter: new Task({ name: "Enter", actions: [Action.flash("hi")] }),
        })
      )
    );
    const recovered = asCompilable(plain);
    expect(recovered).toBeInstanceOf(Profile);
    expect((recovered as Profile).name).toBe("Alien Profile");
  });

  it("accepts a structurally-matching plain Project", () => {
    const plain = JSON.parse(
      JSON.stringify(
        new Project({
          name: "Alien Project",
          tasks: [new Task({ name: "T", actions: [Action.flash("hi")] })],
        })
      )
    );
    const recovered = asCompilable(plain);
    expect(recovered).toBeInstanceOf(Project);
    expect((recovered as Project).name).toBe("Alien Project");
  });

  it("rejects a plain object that fails schema validation", () => {
    expect(asCompilable({ name: "Bad", triggers: "not-an-array-of-triggers" })).toBeUndefined();
    expect(asCompilable({ name: "Bad", actions: "not-an-array" })).toBeUndefined();
    expect(asCompilable({ name: "Bad", triggers: [{ _tag: "NotATrigger" }] })).toBeUndefined();
  });
});

describe("detectRepoFromGit", () => {
  it.effect("parses the repo from a successful git command", () =>
    Effect.gen(function* () {
      const repo = yield* detectRepoFromGit().pipe(
        Effect.provide(
          fakeCommandExecutorLayer({
            stdout: "https://github.com/acme/automations.git\n",
            exitCode: 0,
          })
        )
      );
      expect(repo).toEqual({ owner: "acme", repo: "automations" });
    })
  );

  it.effect("fails when the git command itself cannot be spawned", () =>
    Effect.gen(function* () {
      const failingExecutor = Layer.succeed(
        CommandExecutor.CommandExecutor,
        CommandExecutor.makeExecutor(() =>
          Effect.fail({
            _tag: "SystemError",
            reason: "NotFound",
            module: "Command",
            method: "spawn",
            pathOrDescriptor: "git",
            message: "spawn git ENOENT",
          } as never)
        )
      );
      const error = yield* detectRepoFromGit().pipe(
        Effect.provide(failingExecutor),
        Effect.flip
      );
      expect(error._tag).toBe("RepoDetectionError");
      expect(error.message).toContain("Could not run");
    })
  );

  it.effect("fails when git exits non-zero", () =>
    Effect.gen(function* () {
      const error = yield* detectRepoFromGit().pipe(
        Effect.provide(fakeCommandExecutorLayer({ exitCode: 1 })),
        Effect.flip
      );
      expect(error._tag).toBe("RepoDetectionError");
      expect(error.message).toContain("exit code 1");
    })
  );

  it.effect("fails when the origin remote is not a GitHub URL", () =>
    Effect.gen(function* () {
      const error = yield* detectRepoFromGit().pipe(
        Effect.provide(
          fakeCommandExecutorLayer({
            stdout: "https://gitlab.com/acme/automations.git\n",
            exitCode: 0,
          })
        ),
        Effect.flip
      );
      expect(error._tag).toBe("RepoDetectionError");
      expect(error.message).toContain("not a GitHub repository URL");
    })
  );
});

describe("formatCliError", () => {
  it("formats every CLI failure tag", () => {
    expect(
      formatCliError(
        new CompileError({ message: "bad task", source: "MyTask" })
      )
    ).toBe('Compilation failed: bad task (while compiling "MyTask")');
    expect(formatCliError(new CompileError({ message: "bad task" }))).toBe(
      "Compilation failed: bad task"
    );
    expect(
      formatCliError(
        new EntryNotFoundError({ message: "not found", tried: ["a.ts"] })
      )
    ).toBe("not found");
    expect(
      formatCliError(
        new EntryImportError({ message: "import failed", entry: "a.ts" })
      )
    ).toBe("import failed");
    expect(
      formatCliError(
        new NoCompilableExportsError({ message: "nothing here", entry: "a.ts" })
      )
    ).toBe("nothing here");
    expect(
      formatCliError(new RepoDetectionError({ message: "no repo" }))
    ).toBe(
      "no repo\nPass --repo <owner>/<name> to set the GitHub repository explicitly."
    );
    expect(
      formatCliError(
        new StorageWriteError({ message: "disk full", path: "/x/y.js" })
      )
    ).toBe("Failed to write /x/y.js: disk full");
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

  it.scoped(
    "treats a failing fs.exists() check as not-found rather than propagating",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const outDir = yield* fs.makeTempDirectoryScoped({
          prefix: "tasker-effect-cli-",
        });
        const flakyFs = FileSystem.makeNoop({
          exists: () =>
            Effect.fail({
              _tag: "SystemError",
              reason: "Unknown",
              module: "FileSystem",
              method: "exists",
              pathOrDescriptor: "?",
              message: "boom",
            } as never),
        });
        const error = yield* compileEntry({
          entry: FIXTURE_ENTRY,
          outDir,
        }).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, flakyFs)), Effect.flip);
        expect(error._tag).toBe("EntryNotFoundError");
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

  it.scoped("fails with EntryImportError when the entry throws on import", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outDir = yield* fs.makeTempDirectoryScoped({
        prefix: "tasker-effect-cli-",
      });
      const error = yield* compileEntry({ entry: THROWS_ENTRY, outDir }).pipe(
        Effect.flip
      );
      expect(error._tag).toBe("EntryImportError");
      expect(error.message).toContain("boom: this module cannot be imported");
    }).pipe(Effect.provide(CliTestLayer))
  );

  it.scoped(
    "a .js import failure never adds the Bun hint, regardless of runtime",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const outDir = yield* fs.makeTempDirectoryScoped({
          prefix: "tasker-effect-cli-",
        });
        const error = yield* compileEntry({ entry: THROWS_JS_ENTRY, outDir }).pipe(
          Effect.flip
        );
        expect(error._tag).toBe("EntryImportError");
        expect(error.message).not.toContain("TypeScript entries require Bun");
      }).pipe(Effect.provide(CliTestLayer))
  );

  it.scoped(
    "the EntryImportError message hints at Bun when a .ts import fails off-Bun",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const outDir = yield* fs.makeTempDirectoryScoped({
          prefix: "tasker-effect-cli-",
        });
        const g = globalThis as { Bun?: unknown };
        const savedBun = g.Bun;
        delete g.Bun;
        const error = yield* compileEntry({ entry: THROWS_ENTRY, outDir }).pipe(
          Effect.flip,
          Effect.ensuring(
            Effect.sync(() => {
              g.Bun = savedBun;
            })
          )
        );
        expect(error._tag).toBe("EntryImportError");
        expect(error.message).toContain("TypeScript entries require Bun");
      }).pipe(Effect.provide(CliTestLayer))
  );

  it.scoped("defaults to tasks/automations.ts when no entry is given", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outDir = yield* fs.makeTempDirectoryScoped({
        prefix: "tasker-effect-cli-",
      });
      const result = yield* compileEntry({
        outDir,
        repo: { owner: "acme", repo: "automations" },
      });
      expect(result.entry).toContain("tasks/automations.ts");
      expect(result.files.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(CliTestLayer))
  );

  it.scoped("auto-detects the repo from git when --repo is omitted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outDir = yield* fs.makeTempDirectoryScoped({
        prefix: "tasker-effect-cli-",
      });
      const result = yield* compileEntry({ entry: FIXTURE_ENTRY, outDir });
      const projectXml = result.files.find(
        (file) => file.filename === "tasker-effect.prj.xml"
      );
      expect(projectXml).toBeDefined();
    }).pipe(Effect.provide(CliTestLayer))
  );

  it.scoped("warns and lets the later export win when two exports collide on a filename", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outDir = yield* fs.makeTempDirectoryScoped({
        prefix: "tasker-effect-cli-",
      });
      const result = yield* compileEntry({ entry: COLLISION_ENTRY, outDir });
      const matches = result.files.filter((file) => file.filename === "same-name.js");
      expect(matches.map((file) => file.exportName)).toEqual(["first", "second"]);
      const content = yield* fs.readFileString(path.join(outDir, "same-name.js"));
      expect(content).toContain('flash("second");');
    }).pipe(Effect.provide(CliTestLayer))
  );

  it.scoped("fails with StorageWriteError when the output path cannot be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmpDir = yield* fs.makeTempDirectoryScoped({
        prefix: "tasker-effect-cli-",
      });
      // outDir points at a plain file, so `mkdir -p` for it fails.
      const outDir = path.join(tmpDir, "not-a-directory");
      yield* fs.writeFileString(outDir, "occupied");
      const error = yield* compileEntry({ entry: FIXTURE_ENTRY, outDir }).pipe(
        Effect.flip
      );
      expect(error._tag).toBe("StorageWriteError");
    }).pipe(Effect.provide(CliTestLayer))
  );
});

// These call `runCli` in-process (against source, not the built dist): they
// exist for coverage of the Command wiring and `runCli`'s own error
// reporting. The "spawned" suite below additionally proves the packaged bin
// works end to end.
describe("runCli (in-process)", () => {
  it.effect("--help prints usage and exits 0", () =>
    Effect.gen(function* () {
      const exitCode = yield* Effect.promise(() => runCli(["--help"]));
      expect(exitCode).toBe(0);
    })
  );

  it.effect("rejects a malformed --repo with exit code 1", () =>
    Effect.gen(function* () {
      const exitCode = yield* Effect.promise(() =>
        runCli(["compile", "--repo", "not-a-slug"])
      );
      expect(exitCode).toBe(1);
    })
  );

  it.scoped("compiles a fixture entry to the requested output dir and exits 0", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outDir = yield* fs.makeTempDirectoryScoped({
        prefix: "tasker-effect-cli-",
      });
      const exitCode = yield* Effect.promise(() =>
        runCli([
          "compile",
          FIXTURE_ENTRY,
          "--out",
          outDir,
          "--repo",
          "acme/automations",
        ])
      );
      expect(exitCode).toBe(0);
      expect(yield* fs.exists(`${outDir}/greet.js`)).toBe(true);
    }).pipe(Effect.provide(NodeContext.layer))
  );

  it.effect("reports EntryNotFoundError with exit code 1", () =>
    Effect.gen(function* () {
      const exitCode = yield* Effect.promise(() =>
        runCli(["compile", "no/such/entry.ts", "--repo", "acme/automations"])
      );
      expect(exitCode).toBe(1);
    })
  );

  it.effect("reports NoCompilableExportsError with exit code 1", () =>
    Effect.gen(function* () {
      const exitCode = yield* Effect.promise(() =>
        runCli(["compile", EMPTY_ENTRY, "--repo", "acme/automations"])
      );
      expect(exitCode).toBe(1);
    })
  );

  it.effect("reports a linker CompileError with exit code 1", () =>
    Effect.gen(function* () {
      // The fixture's Project references a task not listed in `tasks:`,
      // which fails the dispatcher's static link check.
      const exitCode = yield* Effect.promise(() =>
        runCli(["compile", BROKEN_LINK_ENTRY, "--repo", "acme/automations"])
      );
      expect(exitCode).toBe(1);
    })
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
