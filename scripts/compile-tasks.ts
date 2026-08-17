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

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { TaskerCompiler } from "../src/compiler.js";
import { FileStore } from "../src/sync/node.js";
import { automations } from "../tasks/automations.js";

const OUTPUT_DIR = "dist-tasker";
const SCRIPTS_DIR = "tasks/scripts";

const compileDslProject = Effect.gen(function* () {
  const compiler = yield* TaskerCompiler;
  const files = yield* FileStore;

  const outputs = yield* compiler.compileProject(automations);
  for (const file of outputs) {
    yield* files.writeText(join(OUTPUT_DIR, file.filename), file.content);
    yield* Effect.log("Compiled", { file: file.filename, kind: file.kind });
  }
  return outputs.length;
});

const bundleEffectScripts = Effect.gen(function* () {
  const entrypoints = readdirSync(SCRIPTS_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(SCRIPTS_DIR, name));

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
    catch: (cause) => new Error(`Bun.build failed: ${String(cause)}`),
  });

  if (!result.success) {
    return yield* Effect.fail(
      new Error(result.logs.map((log) => log.message).join("\n"))
    );
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
    Effect.provide(Layer.mergeAll(TaskerCompiler.Default, FileStore.Default))
  )
).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
