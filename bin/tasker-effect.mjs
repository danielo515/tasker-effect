#!/usr/bin/env node
// Entry point for the `tasker-effect` bin. In the published package the CLI
// is compiled to dist/cli.js; in an in-repo checkout (dist not built) we fall
// back to the TypeScript source, which requires running under Bun.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const distUrl = new URL("../dist/cli.js", import.meta.url);
const srcUrl = new URL("../src/cli.ts", import.meta.url);
const entry = existsSync(fileURLToPath(distUrl)) ? distUrl : srcUrl;

const { runCli } = await import(entry.href);
process.exitCode = await runCli(process.argv.slice(2));
