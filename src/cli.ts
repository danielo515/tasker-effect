/**
 * @module cli
 * @description Compile-only command line interface.
 *
 * `bunx tasker-effect compile [entry] [--out <dir>]` imports an entry module,
 * collects every export (default and named) that is a {@link Project},
 * {@link Profile} or {@link Task}, compiles them to Tasker-executable
 * JavaScript and writes the files to the output directory.
 *
 * Scope is DSL codegen only: bundling Effect programs for Tasker is
 * intentionally left to the consumer (see the --help footer).
 *
 * This module is a sanctioned Node edge (like `src/sync/node.ts`): program
 * logic is written against `@effect/platform` interfaces and the concrete
 * `NodeContext.layer` is provided only in {@link runCli}. It is not exported
 * from the package root, so device/browser bundles can never pull it in.
 */

import { Args, Command, HelpDoc, Options, ValidationError } from "@effect/cli";
import {
  Command as PlatformCommand,
  FileSystem,
  Path,
} from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Console, Effect, Either, Layer, Option, Schema, Stream } from "effect";
import { TaskerCompiler, type CompiledFile, type RepoRef } from "./compiler.js";
import { Profile, Project, Task } from "./profile.js";
import { FileStore } from "./sync/node.js";

// =============================================================================
// Errors
// =============================================================================

/** No entry module was found at any of the candidate paths */
export class EntryNotFoundError extends Schema.TaggedError<EntryNotFoundError>()(
  "EntryNotFoundError",
  {
    message: Schema.String,
    tried: Schema.Array(Schema.String),
  }
) {}

/** The entry module exists but could not be imported */
export class EntryImportError extends Schema.TaggedError<EntryImportError>()(
  "EntryImportError",
  {
    message: Schema.String,
    entry: Schema.String,
  }
) {}

/** The entry module has no Project/Profile/Task exports */
export class NoCompilableExportsError extends Schema.TaggedError<NoCompilableExportsError>()(
  "NoCompilableExportsError",
  {
    message: Schema.String,
    entry: Schema.String,
  }
) {}

/** The GitHub repository could not be determined for a Project compile */
export class RepoDetectionError extends Schema.TaggedError<RepoDetectionError>()(
  "RepoDetectionError",
  {
    message: Schema.String,
  }
) {}

// =============================================================================
// GitHub repo detection
// =============================================================================

/**
 * Parse a GitHub remote URL into its owner/repo pair. Understands the
 * `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo.git` and
 * `https://github.com/owner/repo(.git)` forms; anything else (including
 * non-GitHub hosts) yields undefined.
 */
export const parseGitHubRepo = (url: string): RepoRef | undefined => {
  const match =
    /^(?:git@github\.com:|(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url.trim()
    );
  if (match === null) return undefined;
  return { owner: match[1]!, repo: match[2]! };
};

/** Run `git remote get-url origin`, capturing exit code and stdout */
const gitOriginRemote = Effect.scoped(
  Effect.gen(function* () {
    const process = yield* PlatformCommand.start(
      PlatformCommand.make("git", "remote", "get-url", "origin")
    );
    const output = yield* process.stdout.pipe(
      Stream.decodeText(),
      Stream.mkString
    );
    const exitCode = yield* process.exitCode;
    return { exitCode, output };
  })
);

/**
 * Detect the consumer repo from `git remote get-url origin` in the current
 * working directory. Used when compiling a Project without `--repo`.
 */
export const detectRepoFromGit = Effect.fn("cli.detectRepoFromGit")(
  function* () {
    const { exitCode, output } = yield* gitOriginRemote.pipe(
      Effect.mapError(
        (cause) =>
          new RepoDetectionError({
            message: `Could not run \`git remote get-url origin\`: ${String(cause)}`,
          })
      )
    );
    if (exitCode !== 0) {
      return yield* new RepoDetectionError({
        message: `\`git remote get-url origin\` failed with exit code ${exitCode}`,
      });
    }
    const repo = parseGitHubRepo(output);
    if (repo === undefined) {
      return yield* new RepoDetectionError({
        message: `The origin remote "${output.trim()}" is not a GitHub repository URL`,
      });
    }
    return repo;
  }
);

// =============================================================================
// Export scanning
// =============================================================================

/** A compilable definition found in the entry module */
export interface CompilableExport {
  readonly exportName: string;
  readonly value: Project | Profile | Task;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const decodeOrUndefined = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Either.getOrUndefined(Schema.decodeUnknownEither(schema)(value));

/**
 * Recognize a value as a Project, Profile or Task. Instances are accepted
 * directly; structurally-matching plain objects (e.g. instances created by a
 * different copy of this library, where `instanceof` fails) are validated
 * through the schemas and re-instantiated.
 */
export const asCompilable = (
  value: unknown
): Project | Profile | Task | undefined => {
  if (
    value instanceof Project ||
    value instanceof Profile ||
    value instanceof Task
  ) {
    return value;
  }
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  if (Array.isArray(value.triggers)) return decodeOrUndefined(Profile, value);
  if (Array.isArray(value.actions)) return decodeOrUndefined(Task, value);
  if (Array.isArray(value.profiles) || Array.isArray(value.tasks)) {
    return decodeOrUndefined(Project, value);
  }
  return undefined;
};

/** Collect every compilable export (default and named) of a module */
export const collectCompilables = (
  module: Record<string, unknown>
): Array<CompilableExport> =>
  Object.entries(module).flatMap(([exportName, raw]) => {
    const value = asCompilable(raw);
    return value === undefined ? [] : [{ exportName, value }];
  });

// =============================================================================
// Compilation pipeline
// =============================================================================

const DEFAULT_ENTRIES = ["tasks/automations.ts", "tasks/automations.js"] as const;
const DEFAULT_OUT_DIR = "dist-tasker";

const resolveEntry = Effect.fn("cli.resolveEntry")(function* (
  entry: string | undefined
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates = entry !== undefined ? [entry] : [...DEFAULT_ENTRIES];
  for (const candidate of candidates) {
    const exists = yield* fs
      .exists(candidate)
      .pipe(Effect.orElseSucceed(() => false));
    if (exists) return path.resolve(candidate);
  }
  return yield* new EntryNotFoundError({
    message: `Entry module not found. Tried: ${candidates.join(", ")}`,
    tried: candidates,
  });
});

const importEntry = Effect.fn("cli.importEntry")(function* (entryPath: string) {
  const path = yield* Path.Path;
  const tsHint =
    /\.(ts|tsx|mts|cts)$/.test(entryPath) && typeof Bun === "undefined"
      ? " TypeScript entries require Bun — run this via `bunx tasker-effect`."
      : "";
  const toError = (cause: unknown) =>
    new EntryImportError({
      message: `Failed to import ${entryPath}: ${String(cause)}.${tsHint}`,
      entry: entryPath,
    });
  const entryUrl = yield* path.toFileUrl(entryPath).pipe(Effect.mapError(toError));
  return yield* Effect.tryPromise({
    try: () => import(entryUrl.href) as Promise<Record<string, unknown>>,
    catch: toError,
  });
});

/** One file written by a compile run */
export interface WrittenFile {
  readonly filename: string;
  readonly exportName: string;
  readonly kind: CompiledFile["kind"];
}

/** Result of a compile run */
export interface CompileRunResult {
  readonly entry: string;
  readonly outDir: string;
  readonly exports: ReadonlyArray<string>;
  readonly files: ReadonlyArray<WrittenFile>;
}

/**
 * Compile every Project/Profile/Task export of the entry module and write
 * the resulting JavaScript files (plus setup READMEs for projects) to
 * `outDir`.
 */
export const compileEntry = Effect.fn("cli.compileEntry")(function* (options: {
  readonly entry?: string | undefined;
  readonly outDir: string;
  readonly repo?: RepoRef | undefined;
}) {
  const compiler = yield* TaskerCompiler;
  const store = yield* FileStore;

  const entryPath = yield* resolveEntry(options.entry);
  const module = yield* importEntry(entryPath);
  const compilables = collectCompilables(module);
  if (compilables.length === 0) {
    return yield* new NoCompilableExportsError({
      message:
        `${entryPath} has no compilable exports. ` +
        "Export (default or named) Project, Profile or Task instances from tasker-effect.",
      entry: entryPath,
    });
  }

  // Only Project compiles need the repo (for the sync bootstrap in the
  // project XML); detect it lazily so Profile/Task-only entries never
  // require git or --repo.
  let repo = options.repo;
  const resolveRepo = Effect.gen(function* () {
    if (repo === undefined) {
      repo = yield* detectRepoFromGit();
    }
    return repo;
  });

  const written: Array<WrittenFile> = [];
  const seen = new Map<string, string>();
  for (const { exportName, value } of compilables) {
    const files =
      value instanceof Project
        ? yield* compiler.compileProject(value, { repo: yield* resolveRepo })
        : value instanceof Profile
          ? yield* compiler.compileProfile(value)
          : [yield* compiler.compileTask(value)];

    for (const file of files) {
      const previous = seen.get(file.filename);
      if (previous !== undefined) {
        yield* Console.warn(
          `warning: ${file.filename} is produced by both "${previous}" and "${exportName}"; the latter wins`
        );
      }
      seen.set(file.filename, exportName);
      yield* store.writeText(`${options.outDir}/${file.filename}`, file.content);
      written.push({ filename: file.filename, exportName, kind: file.kind });
    }
  }

  return {
    entry: entryPath,
    outDir: options.outDir,
    exports: compilables.map(({ exportName }) => exportName),
    files: written,
  } satisfies CompileRunResult;
});

const runCompile = Effect.fn("cli.runCompile")(function* (options: {
  readonly entry?: string | undefined;
  readonly outDir: string;
  readonly repo?: RepoRef | undefined;
}) {
  const result = yield* compileEntry(options);
  yield* Console.log(
    `Compiled ${result.exports.length} export(s) from ${result.entry}:`
  );
  for (const file of result.files) {
    yield* Console.log(
      `  ${result.outDir}/${file.filename}  (${file.kind}, from "${file.exportName}")`
    );
  }
  yield* Console.log(`${result.files.length} file(s) written to ${result.outDir}`);
});

// =============================================================================
// Command definition (@effect/cli)
// =============================================================================

const entryArg = Args.file({ name: "entry" }).pipe(
  Args.withDescription(
    "Module whose exports (default and named) are scanned for Project, " +
      `Profile and Task instances. Default: ${DEFAULT_ENTRIES[0]} (then ${DEFAULT_ENTRIES[1]})`
  ),
  Args.optional
);

const outOption = Options.directory("out").pipe(
  Options.withDescription("Output directory"),
  Options.withDefault(DEFAULT_OUT_DIR)
);

const repoOption = Options.text("repo").pipe(
  Options.mapTryCatch(
    (value): RepoRef => {
      const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
      if (match === null) {
        throw new Error(`Invalid repository: ${value}`);
      }
      return { owner: match[1]!, repo: match[2]! };
    },
    () => HelpDoc.p("--repo requires a GitHub repository as <owner>/<name>")
  ),
  Options.withDescription(
    "GitHub repository (<owner>/<name>) embedded in the generated project " +
      "XML's sync bootstrap. Default: detected from `git remote get-url " +
      "origin`. Only needed for Projects."
  ),
  Options.optional
);

const compileCommand = Command.make(
  "compile",
  { entry: entryArg, out: outOption, repo: repoOption },
  ({ entry, out, repo }) =>
    runCompile({
      entry: Option.getOrUndefined(entry),
      outDir: out,
      repo: Option.getOrUndefined(repo),
    })
).pipe(
  Command.withDescription(
    "Compile the Project/Profile/Task exports of an entry module to " +
      "Tasker-executable JavaScript"
  )
);

const rootCommand = Command.make("tasker-effect").pipe(
  Command.withDescription(
    "Compile Tasker DSL definitions to Tasker-executable JavaScript"
  ),
  Command.withSubcommands([compileCommand])
);

const cli = Command.run(rootCommand, {
  name: "tasker-effect",
  version: "0.1.0",
  footer: HelpDoc.blocks([
    HelpDoc.p(
      "TypeScript entries require Bun (run via `bunx tasker-effect`). " +
        "Plain JavaScript entries also work under Node (`npx tasker-effect`)."
    ),
    HelpDoc.p(
      "Only the declarative DSL is compiled. Bundling Effect programs for " +
        "Tasker is intentionally left to the consumer, e.g.: esbuild " +
        "script.ts --bundle --minify --format=iife --platform=browser " +
        "--outfile=dist-tasker/script.js"
    ),
  ]),
});

// =============================================================================
// Edge: process runner
// =============================================================================

const CliLive = Layer.mergeAll(
  TaskerCompiler.Default,
  FileStore.Default,
  NodeContext.layer
);

/**
 * Run the CLI with the given argv (excluding the runtime/script prefix) and
 * resolve to a process exit code. This is the only place effects are run and
 * the only place the concrete Node platform layer is provided.
 */
export const runCli = (argv: ReadonlyArray<string>): Promise<number> =>
  Effect.runPromise(
    cli(["node", "tasker-effect", ...argv]).pipe(
      Effect.as(0),
      Effect.catchTags({
        EntryNotFoundError: (error) =>
          Console.error(error.message).pipe(Effect.as(1)),
        EntryImportError: (error) =>
          Console.error(error.message).pipe(Effect.as(1)),
        NoCompilableExportsError: (error) =>
          Console.error(error.message).pipe(Effect.as(1)),
        RepoDetectionError: (error) =>
          Console.error(
            `${error.message}\n` +
              "Pass --repo <owner>/<name> to set the GitHub repository explicitly."
          ).pipe(Effect.as(1)),
        CompileError: (error) =>
          Console.error(
            `Compilation failed: ${error.message}` +
              (error.source !== undefined
                ? ` (while compiling "${error.source}")`
                : "")
          ).pipe(Effect.as(1)),
        StorageWriteError: (error) =>
          Console.error(`Failed to write ${error.path}: ${error.message}`).pipe(
            Effect.as(1)
          ),
      }),
      // @effect/cli already printed the validation error (with usage) itself.
      Effect.catchIf(ValidationError.isValidationError, () => Effect.succeed(1)),
      Effect.provide(CliLive)
    )
  );
