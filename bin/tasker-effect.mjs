#!/usr/bin/env node
// Entry point for the `tasker-effect` bin. It runs the compiled CLI from
// dist/ — in a published install dist/ always exists; in a repo checkout,
// build it first with `bun run build`.
let cli;
try {
  cli = await import(new URL("../dist/cli.js", import.meta.url).href);
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
    throw new Error(
      "tasker-effect: dist/cli.js could not be loaded — build it first with `bun run build`.",
      { cause: error }
    );
  }
  throw error;
}
process.exitCode = await cli.runCli(process.argv.slice(2));
