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
 * intentionally left to the consumer (see the --help text).
 */

import { Console, Effect, Either, Layer, Schema } from "effect";
import { TaskerCompiler, type CompiledFile, type RepoRef } from "./compiler.js";
import { Profile, Project, Task } from "./profile.js";
import { FileStore } from "./sync/node.js";

// =============================================================================
// Errors
// =============================================================================

/** The command line arguments could not be parsed */
export class CliUsageError extends Schema.TaggedError<CliUsageError>()(
  "CliUsageError",
  {
    message: Schema.String,
  }
) {}

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

/**
 * Detect the consumer repo from `git remote get-url origin` in the current
 * working directory. Used when compiling a Project without `--repo`.
 */
export const detectRepoFromGit = Effect.fn("cli.detectRepoFromGit")(
  function* () {
    const remoteUrl = yield* Effect.tryPromise({
      try: async () => {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const { stdout } = await promisify(execFile)("git", [
          "remote",
          "get-url",
          "origin",
        ]);
        return stdout.trim();
      },
      catch: (cause) =>
        new RepoDetectionError({
          message: `Could not run \`git remote get-url origin\`: ${String(cause)}`,
        }),
    });
    const repo = parseGitHubRepo(remoteUrl);
    if (repo === undefined) {
      return yield* Effect.fail(
        new RepoDetectionError({
          message: `The origin remote "${remoteUrl}" is not a GitHub repository URL`,
        })
      );
    }
    return repo;
  }
);

// =============================================================================
// Argument parsing
// =============================================================================

const DEFAULT_ENTRIES = ["tasks/automations.ts", "tasks/automations.js"] as const;
const DEFAULT_OUT_DIR = "dist-tasker";

/** A parsed CLI invocation */
export type CliInvocation =
  | { readonly _tag: "Help" }
  | {
      readonly _tag: "Compile";
      readonly entry: string | undefined;
      readonly outDir: string;
      readonly repo: RepoRef | undefined;
    };

export const HELP_TEXT = `tasker-effect — compile Tasker DSL definitions to Tasker-executable JavaScript

Usage:
  tasker-effect compile [entry] [--out <dir>] [--repo <owner>/<name>]

Arguments:
  entry          Module whose exports (default and named) are scanned for
                 Project, Profile and Task instances.
                 Default: ${DEFAULT_ENTRIES[0]} (then ${DEFAULT_ENTRIES[1]})
  --out <dir>    Output directory. Default: ${DEFAULT_OUT_DIR}
  --repo <o>/<n> GitHub repository embedded in the generated project XML's
                 sync bootstrap. Default: detected from
                 \`git remote get-url origin\`. Only needed for Projects.
  -h, --help     Show this help.

Runtimes:
  TypeScript entries require Bun (run via \`bunx tasker-effect\`).
  Plain JavaScript entries also work under Node (\`npx tasker-effect\`).

Scope:
  This command only compiles the declarative DSL. Bundling Effect programs
  for Tasker is intentionally left to the consumer, e.g.:
    esbuild script.ts --bundle --minify --format=iife --platform=browser --outfile=dist-tasker/script.js`;

/** Parse raw argv (without the node/bun prefix) into an invocation */
export const parseCliArgs = (
  argv: ReadonlyArray<string>
): Either.Either<CliInvocation, CliUsageError> => {
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h") {
    return Either.right({ _tag: "Help" });
  }
  if (first !== "compile") {
    return Either.left(
      new CliUsageError({ message: `Unknown command: ${first}` })
    );
  }

  let entry: string | undefined;
  let outDir = DEFAULT_OUT_DIR;
  let repo: RepoRef | undefined;
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--help" || arg === "-h") {
      return Either.right({ _tag: "Help" });
    }
    if (arg === "--out") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return Either.left(
          new CliUsageError({ message: "--out requires a directory argument" })
        );
      }
      outDir = value;
      i++;
      continue;
    }
    if (arg === "--repo") {
      const value = rest[i + 1];
      const match =
        value === undefined
          ? null
          : /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
      if (match === null) {
        return Either.left(
          new CliUsageError({
            message: "--repo requires a GitHub repository as <owner>/<name>",
          })
        );
      }
      repo = { owner: match[1]!, repo: match[2]! };
      i++;
      continue;
    }
    if (arg.startsWith("-")) {
      return Either.left(new CliUsageError({ message: `Unknown option: ${arg}` }));
    }
    if (entry !== undefined) {
      return Either.left(
        new CliUsageError({
          message: `Unexpected extra argument: ${arg} (only one entry is supported)`,
        })
      );
    }
    entry = arg;
  }
  return Either.right({ _tag: "Compile", entry, outDir, repo });
};

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

const resolveEntry = Effect.fn("cli.resolveEntry")(function* (
  entry: string | undefined
) {
  const candidates = entry !== undefined ? [entry] : [...DEFAULT_ENTRIES];
  const found = yield* Effect.promise(async () => {
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const candidate of candidates) {
      if (existsSync(candidate)) return resolve(candidate);
    }
    return undefined;
  });
  if (found === undefined) {
    return yield* Effect.fail(
      new EntryNotFoundError({
        message: `Entry module not found. Tried: ${candidates.join(", ")}`,
        tried: candidates,
      })
    );
  }
  return found;
});

const importEntry = Effect.fn("cli.importEntry")(function* (entryPath: string) {
  const { pathToFileURL } = yield* Effect.promise(() => import("node:url"));
  const tsHint =
    /\.(ts|tsx|mts|cts)$/.test(entryPath) && typeof Bun === "undefined"
      ? " TypeScript entries require Bun — run this via `bunx tasker-effect`."
      : "";
  return yield* Effect.tryPromise({
    try: () =>
      import(pathToFileURL(entryPath).href) as Promise<Record<string, unknown>>,
    catch: (cause) =>
      new EntryImportError({
        message: `Failed to import ${entryPath}: ${String(cause)}.${tsHint}`,
        entry: entryPath,
      }),
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
    return yield* Effect.fail(
      new NoCompilableExportsError({
        message:
          `${entryPath} has no compilable exports. ` +
          "Export (default or named) Project, Profile or Task instances from tasker-effect.",
        entry: entryPath,
      })
    );
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
// Edge: process runner
// =============================================================================

const CliLive = Layer.mergeAll(TaskerCompiler.Default, FileStore.Default);

/**
 * Run the CLI with the given argv (excluding the runtime/script prefix) and
 * resolve to a process exit code. This is the only place effects are run.
 */
export const runCli = (argv: ReadonlyArray<string>): Promise<number> => {
  const program = Effect.gen(function* () {
    const invocation = yield* parseCliArgs(argv);
    if (invocation._tag === "Help") {
      yield* Console.log(HELP_TEXT);
      return 0;
    }
    yield* runCompile({
      entry: invocation.entry,
      outDir: invocation.outDir,
      repo: invocation.repo,
    });
    return 0;
  }).pipe(
    Effect.catchTags({
      CliUsageError: (error) =>
        Console.error(`${error.message}\n\n${HELP_TEXT}`).pipe(Effect.as(1)),
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
            (error.source !== undefined ? ` (while compiling "${error.source}")` : "")
        ).pipe(Effect.as(1)),
      StorageWriteError: (error) =>
        Console.error(`Failed to write ${error.path}: ${error.message}`).pipe(
          Effect.as(1)
        ),
    }),
    Effect.provide(CliLive)
  );
  return Effect.runPromise(program);
};
