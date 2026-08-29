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
import {
  Cause,
  Console,
  Effect,
  Either,
  Layer,
  Match,
  Option,
  ParseResult,
  Schema,
  Stream,
} from "effect";
import { CompileError, TaskerCompiler, type CompiledFile, type RepoRef } from "./compiler.js";
import { Profile, Project, Task } from "./profile.js";
import { FileStoreNodeLive } from "./sync/node.js";
import { FileStore, StorageWriteError } from "./sync/contract.js";

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
 * A GitHub `<owner>/<name>` slug, accepted with or without a trailing
 * `.git` (the exact string a `git clone` URL's tail would produce). This is
 * the single place the slug grammar is defined — both `--repo` (via
 * {@link Options.withSchema}) and {@link parseGitHubRepo} decode through it,
 * so the two cannot drift apart.
 */
export const RepoRefFromString = Schema.transformOrFail(
  Schema.String,
  Schema.Struct({ owner: Schema.String, repo: Schema.String }),
  {
    strict: true,
    decode: (value, _options, ast) => {
      const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
        value.trim()
      );
      return match === null
        ? ParseResult.fail(
            new ParseResult.Type(
              ast,
              value,
              "--repo requires a GitHub repository as <owner>/<name>"
            )
          )
        : ParseResult.succeed({ owner: match[1]!, repo: match[2]! });
    },
    encode: (repo) => ParseResult.succeed(`${repo.owner}/${repo.repo}`),
  }
);

/**
 * Parse a GitHub remote URL into its owner/repo pair. Understands the
 * `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo.git` and
 * `https://github.com/owner/repo(.git)` forms; anything else (including
 * non-GitHub hosts) yields undefined. The `<owner>/<name>` tail is decoded
 * through {@link RepoRefFromString}, the same schema `--repo` uses.
 */
export const parseGitHubRepo = (url: string): RepoRef | undefined => {
  const match =
    /^(?:git@github\.com:|(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com\/)([^/\s]+\/[^/\s]+)\/?$/.exec(
      url.trim()
    );
  if (match === null) return undefined;
  return Either.getOrUndefined(
    Schema.decodeUnknownEither(RepoRefFromString)(match[1]!)
  );
};

/** Run `git remote get-url origin`, capturing stdout, stderr and exit code */
const gitOriginRemote = Effect.scoped(
  Effect.gen(function* () {
    const process = yield* PlatformCommand.start(
      PlatformCommand.make("git", "remote", "get-url", "origin")
    );
    const [output, stderr, exitCode] = yield* Effect.all(
      [
        process.stdout.pipe(Stream.decodeText(), Stream.mkString),
        process.stderr.pipe(Stream.decodeText(), Stream.mkString),
        process.exitCode,
      ],
      { concurrency: 3 }
    );
    return { exitCode, output, stderr };
  })
);

/**
 * Detect the consumer repo from `git remote get-url origin` in the current
 * working directory. Used when compiling a Project without `--repo`.
 */
export const detectRepoFromGit = Effect.fn("cli.detectRepoFromGit")(
  function* () {
    const { exitCode, output, stderr } = yield* gitOriginRemote.pipe(
      Effect.mapError(
        (cause) =>
          new RepoDetectionError({
            message: `Could not run \`git remote get-url origin\`: ${
              cause._tag === "SystemError" && cause.reason === "NotFound"
                ? "`git` was not found on PATH"
                : cause.message
            }`,
          })
      )
    );
    if (exitCode !== 0) {
      const detail = stderr.trim();
      return yield* new RepoDetectionError({
        message:
          `\`git remote get-url origin\` failed with exit code ${exitCode}` +
          (detail !== "" ? `: ${detail}` : ""),
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

/** A named export that looked like a DSL definition but failed to decode */
export interface RejectedExport {
  readonly exportName: string;
  readonly error: ParseResult.ParseError;
}

/** Every export of a module, sorted into what compiled and what nearly did */
export interface ScannedExports {
  readonly compilables: Array<CompilableExport>;
  readonly rejected: Array<RejectedExport>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Recognize a value as a Project, Profile or Task, keeping the `ParseError`
 * on a near-miss. Instances are accepted directly; structurally-matching
 * plain objects (e.g. instances created by a different copy of this
 * library, where `instanceof` fails) are validated through the schemas and
 * re-instantiated. `undefined` means the value did not even have the shape
 * (an array field) needed to try decoding it as one of the three.
 */
export const asCompilableEither = (
  value: unknown
): Either.Either<Project | Profile | Task, ParseResult.ParseError> | undefined => {
  if (
    value instanceof Project ||
    value instanceof Profile ||
    value instanceof Task
  ) {
    return Either.right(value);
  }
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  if (Array.isArray(value.triggers)) {
    return Schema.decodeUnknownEither(Profile)(value);
  }
  if (Array.isArray(value.actions)) {
    return Schema.decodeUnknownEither(Task)(value);
  }
  if (Array.isArray(value.profiles) || Array.isArray(value.tasks)) {
    return Schema.decodeUnknownEither(Project)(value);
  }
  return undefined;
};

/**
 * Recognize a value as a Project, Profile or Task. Same dispatch as
 * {@link asCompilableEither}, collapsing a decode failure to `undefined`.
 */
export const asCompilable = (value: unknown): Project | Profile | Task | undefined => {
  const either = asCompilableEither(value);
  return either === undefined ? undefined : Either.getOrUndefined(either);
};

/** Collect every compilable export (default and named) of a module */
export const collectCompilables = (
  module: Record<string, unknown>
): Array<CompilableExport> => scanExports(module).compilables;

/**
 * Like {@link collectCompilables}, but also surfaces exports that looked
 * like a DSL definition (had the right shape) yet failed schema validation,
 * so callers can warn instead of silently dropping them.
 */
export const scanExports = (module: Record<string, unknown>): ScannedExports => {
  const compilables: Array<CompilableExport> = [];
  const rejected: Array<RejectedExport> = [];
  for (const [exportName, raw] of Object.entries(module)) {
    const either = asCompilableEither(raw);
    if (either === undefined) continue;
    Either.match(either, {
      onLeft: (error) => rejected.push({ exportName, error }),
      onRight: (value) => compilables.push({ exportName, value }),
    });
  }
  return { compilables, rejected };
};

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
  const { compilables, rejected } = scanExports(module);
  for (const { exportName, error } of rejected) {
    yield* Console.warn(
      `warning: export "${exportName}" looks like a DSL definition but failed to decode: ` +
        ParseResult.TreeFormatter.formatErrorSync(error)
    );
  }
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
  // require git or --repo. Effect.cached both memoizes the result across
  // multiple Project exports and single-flights a concurrent detection.
  const resolveRepo = yield* Effect.cached(
    options.repo !== undefined ? Effect.succeed(options.repo) : detectRepoFromGit()
  );

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
  Options.withSchema(RepoRefFromString),
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
  FileStoreNodeLive,
  NodeContext.layer
);

/** Union of every error `runCli` reports on stderr with exit code 1 */
type CliFailure =
  | EntryNotFoundError
  | EntryImportError
  | NoCompilableExportsError
  | RepoDetectionError
  | CompileError
  | StorageWriteError;

/** Render a `CliFailure` as the message printed to stderr */
export const formatCliError = (error: CliFailure): string =>
  Match.value(error).pipe(
    Match.tag("EntryNotFoundError", (e) => e.message),
    Match.tag("EntryImportError", (e) => e.message),
    Match.tag("NoCompilableExportsError", (e) => e.message),
    Match.tag(
      "RepoDetectionError",
      (e) =>
        `${e.message}\n` +
        "Pass --repo <owner>/<name> to set the GitHub repository explicitly."
    ),
    Match.tag(
      "CompileError",
      (e) =>
        `Compilation failed: ${e.message}` +
        (e.source !== undefined ? ` (while compiling "${e.source}")` : "")
    ),
    Match.tag(
      "StorageWriteError",
      (e) => `Failed to write ${e.path}: ${e.message}`
    ),
    Match.exhaustive
  );

const reportAndFail = (error: CliFailure): Effect.Effect<number> =>
  Console.error(formatCliError(error)).pipe(Effect.as(1));

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
        EntryNotFoundError: reportAndFail,
        EntryImportError: reportAndFail,
        NoCompilableExportsError: reportAndFail,
        RepoDetectionError: reportAndFail,
        CompileError: reportAndFail,
        StorageWriteError: reportAndFail,
      }),
      // @effect/cli already printed the validation error (with usage) itself.
      Effect.catchIf(ValidationError.isValidationError, () => Effect.succeed(1)),
      // A genuine defect (e.g. a Match.exhaustive bug the compiler's own
      // linker cannot catch) must not be reported as "Compilation failed" —
      // that message implies a fixable DSL problem. Print the real Cause
      // (stack included) instead, so an internal bug is diagnosable.
      Effect.catchAllDefect((defect) =>
        Console.error(Cause.pretty(Cause.die(defect))).pipe(Effect.as(1))
      ),
      Effect.provide(CliLive)
    )
  );
