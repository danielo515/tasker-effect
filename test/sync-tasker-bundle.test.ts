import { describe, expect, test } from "bun:test";

/**
 * Guard: the on-device sync bundle must stay runnable inside Tasker's
 * WebView. src/sync/tasker.ts (and everything it reaches) must not pull in
 * @effect/platform-node or any node:* builtin.
 */
describe("sync-profiles device bundle", () => {
  test("bundles without node:* specifiers and parses as plain JS", async () => {
    const result = await Bun.build({
      entrypoints: ["tasks/scripts/sync-profiles.ts"],
      target: "browser",
      format: "iife",
      minify: true,
      sourcemap: "none",
    });

    expect(result.success).toBe(true);
    expect(result.outputs.length).toBe(1);

    const bundle = await result.outputs[0]!.text();
    expect(bundle).not.toContain("node:");
    expect(bundle).not.toContain("@effect/platform-node");
    // Parses without executing: new Function only compiles the body.
    expect(() => new Function(bundle)).not.toThrow();
  });
});
