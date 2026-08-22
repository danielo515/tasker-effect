import { describe, expect, it } from "@effect/vitest";
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";

/**
 * Bundles with the bun CLI (`bun build`): these guard tests run under vitest
 * on Node, where the Bun.build API is unavailable. An empty bundle means the
 * build failed (bun reports errors on stderr and exits non-zero).
 */
const buildDeviceBundle = (entrypoint: string) =>
  Effect.gen(function* () {
    const bundle = yield* Command.string(
      Command.make(
        "bun",
        "build",
        entrypoint,
        "--target=browser",
        "--format=iife",
        "--minify"
      )
    );
    expect(bundle.length).toBeGreaterThan(0);
    return bundle;
  }).pipe(Effect.provide(NodeContext.layer));

const expectParsesAsPlainJs = (bundle: string) => {
  // Parses without executing: new Function only compiles the body.
  // oxlint-disable-next-line typescript/no-implied-eval -- parse-only guard on generated output, never invoked
  expect(() => new Function(bundle)).not.toThrow();
};

/**
 * Guard: the on-device sync bundle must stay runnable inside Tasker's
 * WebView. src/sync/tasker.ts (and everything it reaches) must not pull in
 * @effect/platform-node or any node:* builtin.
 */
describe("sync-profiles device bundle", () => {
  it.effect(
    "bundles without node:* specifiers and parses as plain JS",
    () =>
      Effect.gen(function* () {
        const bundle = yield* buildDeviceBundle("tasks/scripts/sync-profiles.ts");
        expect(bundle).not.toContain("node:");
        expect(bundle).not.toContain("@effect/platform-node");
        expectParsesAsPlainJs(bundle);
      }),
    30_000
  );
});

/**
 * Guard: the library's main entry point must stay device-safe. Only the
 * tasker-effect/sync/node subpath may reach @effect/platform-node — an
 * import of the index (what consumers bundle for the device) must not.
 */
describe("library index graph", () => {
  it.effect(
    "importing src/index.js pulls no node builtins or platform-node",
    () =>
      Effect.gen(function* () {
        const bundle = yield* buildDeviceBundle(
          "test/fixtures/imports-library-index.ts"
        );
        expect(bundle).not.toContain("node:");
        expect(bundle).not.toContain("@effect/platform-node");
        expectParsesAsPlainJs(bundle);
      }),
    30_000
  );
});
