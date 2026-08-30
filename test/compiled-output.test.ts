import { beforeAll, describe, expect, it } from "@effect/vitest";
import { type CompiledFile, compileProjectFiles } from "../src/compiler.js";
import { automations } from "../tasks/automations.js";
import { expectValidJs } from "./support/valid-js.js";

// Global enforcement: whatever the real project in tasks/automations.ts
// grows to contain, every emitted JS file must parse. Individual profile
// tests assert *content*; this suite guarantees *validity* for files those
// tests don't cover. compileProjectFiles runs inside beforeAll (not at
// describe-collection scope) so a CompileError here is a normal failing
// test, not a vitest collection-time crash.
describe("compiled project output", () => {
  let files: ReadonlyArray<CompiledFile> = [];

  beforeAll(() => {
    files = compileProjectFiles(automations, {
      repo: { owner: "acme", repo: "automations" },
    });
  });

  it("every emitted .js file parses as valid JavaScript", () => {
    const jsFiles = files.filter((f) => f.filename.endsWith(".js"));
    expect(jsFiles.length).toBeGreaterThan(0);
    for (const file of jsFiles) {
      expectValidJs(file.content);
    }
  });
});
