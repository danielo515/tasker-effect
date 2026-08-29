#!/usr/bin/env node
/**
 * Compare two dist-tasker/ builds (base branch vs. PR head) and render a
 * Markdown table of per-file and total size deltas, suitable for posting as
 * a PR comment. Used by the `bundle-analyzer` CI job — see
 * .github/workflows/ci.yml.
 *
 * Usage: node scripts/bundle-size-report.mjs <baseDir> <headDir> <outFile>
 */

import { readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = "<!-- bundle-analyzer-report -->";

function readSizes(dir) {
  /** @type {Map<string, number>} */
  const sizes = new Map();
  if (!existsSync(dir)) return sizes;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".js")) continue;
    sizes.set(name, statSync(join(dir, name)).size);
  }
  return sizes;
}

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function formatDelta(delta) {
  const sign = delta > 0 ? "+" : delta < 0 ? "" : "±";
  return `${sign}${(delta / 1024).toFixed(2)} KB`;
}

function formatPercent(delta, base) {
  if (base === 0) return delta === 0 ? "0%" : "new";
  const pct = (delta / base) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function icon(delta) {
  if (delta > 0) return "🔺";
  if (delta < 0) return "🔽";
  return "➖";
}

function main() {
  const [baseDir, headDir, outFile] = process.argv.slice(2);
  if (!baseDir || !headDir || !outFile) {
    console.error(
      "Usage: bundle-size-report.mjs <baseDir> <headDir> <outFile>"
    );
    process.exitCode = 1;
    return;
  }

  const base = readSizes(baseDir);
  const head = readSizes(headDir);
  const files = [...new Set([...base.keys(), ...head.keys()])].sort();

  let totalBase = 0;
  let totalHead = 0;
  const rows = files.map((file) => {
    const baseSize = base.get(file) ?? 0;
    const headSize = head.get(file) ?? 0;
    totalBase += baseSize;
    totalHead += headSize;
    const delta = headSize - baseSize;
    const status = !base.has(file) ? " (new)" : !head.has(file) ? " (removed)" : "";
    return { file: file + status, baseSize, headSize, delta };
  });

  const totalDelta = totalHead - totalBase;

  const lines = [];
  lines.push(MARKER);
  lines.push("## 📦 Bundle size report");
  lines.push("");
  lines.push("Compiled Tasker JS bundles (`dist-tasker/`), base branch vs. this PR:");
  lines.push("");
  lines.push("| File | Base | Head | Δ | % |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    lines.push(
      `| ${row.file} | ${formatBytes(row.baseSize)} | ${formatBytes(row.headSize)} | ${icon(row.delta)} ${formatDelta(row.delta)} | ${formatPercent(row.delta, row.baseSize)} |`
    );
  }
  lines.push(
    `| **Total** | **${formatBytes(totalBase)}** | **${formatBytes(totalHead)}** | **${icon(totalDelta)} ${formatDelta(totalDelta)}** | **${formatPercent(totalDelta, totalBase)}** |`
  );
  lines.push("");
  if (rows.length === 0) {
    lines.push("_No compiled bundles found in either build._");
  }

  writeFileSync(outFile, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

main();
