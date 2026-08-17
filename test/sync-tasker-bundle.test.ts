import { describe, expect, test } from "bun:test";

const buildDeviceBundle = async (entrypoint: string) => {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "iife",
    minify: true,
    sourcemap: "none",
  });

  expect(result.success).toBe(true);
  expect(result.outputs.length).toBe(1);
  return result.outputs[0]!.text();
};

/**
 * Guard: the on-device sync bundle must stay runnable inside Tasker's
 * WebView. src/sync/tasker.ts (and everything it reaches) must not pull in
 * @effect/platform-node or any node:* builtin.
 */
describe("sync-profiles device bundle", () => {
  test("bundles without node:* specifiers and parses as plain JS", async () => {
    const bundle = await buildDeviceBundle("tasks/scripts/sync-profiles.ts");
    expect(bundle).not.toContain("node:");
    expect(bundle).not.toContain("@effect/platform-node");
    // Parses without executing: new Function only compiles the body.
    expect(() => new Function(bundle)).not.toThrow();
  });
});

/**
 * Guard: the library's main entry point must stay device-safe. Only the
 * tasker-effect/sync/node subpath may reach @effect/platform-node — an
 * import of the index (what consumers bundle for the device) must not.
 */
describe("library index graph", () => {
  test("importing src/index.js pulls no node builtins or platform-node", async () => {
    const bundle = await buildDeviceBundle(
      "test/fixtures/imports-library-index.ts"
    );
    expect(bundle).not.toContain("node:");
    expect(bundle).not.toContain("@effect/platform-node");
    expect(() => new Function(bundle)).not.toThrow();
  });
});
