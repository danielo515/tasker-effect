#!/usr/bin/env bun
/**
 * Compile everything under tasks/ into Tasker-executable JavaScript.
 *
 * - tasks/automations.ts (declarative DSL) → one plain JS file per task via
 *   the tasker-effect compiler, plus a setup README.
 * - tasks/scripts/*.ts (Effect-based scripts) → single-file bundles via
 *   Bun.build, ready to run in Tasker with Auto Exit disabled.
 *
 * Output lands in dist-tasker/, which CI uploads as the `tasker-js`
 * artifact and attaches to releases.
 */

import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import { detectRepoFromGit } from "../src/cli.js";
import { TaskerCompiler } from "../src/compiler.js";
import { FileStore } from "../src/sync/node.js";
import { automations } from "../tasks/automations.js";

const OUTPUT_DIR = "dist-tasker";
const SCRIPTS_DIR = "tasks/scripts";

class BundleError extends Schema.TaggedError<BundleError>()("BundleError", {
  message: Schema.String,
}) {}

const compileDslProject = Effect.gen(function* () {
  const compiler = yield* TaskerCompiler;
  const files = yield* FileStore;
  const path = yield* Path.Path;

  const repo = yield* detectRepoFromGit();
  const outputs = yield* compiler.compileProject(automations, { repo });
  for (const file of outputs) {
    yield* files.writeText(path.join(OUTPUT_DIR, file.filename), file.content);
    yield* Effect.log("Compiled", { file: file.filename, kind: file.kind });
  }
  return outputs.length;
});

const bundleEffectScripts = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entrypoints = (yield* fs.readDirectory(SCRIPTS_DIR))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(SCRIPTS_DIR, name));

  if (entrypoints.length === 0) return 0;

  const result = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints,
        outdir: OUTPUT_DIR,
        target: "browser",
        format: "iife",
        minify: true,
        sourcemap: "none",
      }),
    catch: (cause) =>
      new BundleError({ message: `Bun.build failed: ${String(cause)}` }),
  });

  if (!result.success) {
    return yield* new BundleError({
      message: result.logs.map((log) => log.message).join("\n"),
    });
  }

  for (const entry of entrypoints) {
    yield* Effect.log("Bundled", { script: entry });
  }
  return entrypoints.length;
});

const main = Effect.gen(function* () {
  const dslCount = yield* compileDslProject;
  const bundleCount = yield* bundleEffectScripts;
  yield* Effect.log("Compilation complete", {
    output: OUTPUT_DIR,
    dslFiles: dslCount,
    bundledScripts: bundleCount,
  });
});

void Effect.runPromise(
  main.pipe(
    Effect.provide(
      Layer.mergeAll(TaskerCompiler.Default, FileStore.Default, NodeContext.layer)
    ),
    Effect.catchAllCause((cause) =>
      Effect.logError("Compilation failed", cause).pipe(
        Effect.andThen(Effect.sync(() => {
          process.exitCode = 1;
        }))
      )
    )
  )
).catch(() => {
  // All failures are logged and handled above; this only guards against the
  // runtime itself failing to start.
  process.exitCode = 1;
});
