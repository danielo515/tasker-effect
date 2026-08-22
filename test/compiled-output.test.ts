import { describe, it } from "@effect/vitest";
import { compileProjectFiles } from "../src/compiler.js";
import { automations } from "../tasks/automations.js";
import { expectValidJs } from "./support/valid-js.js";

// Global enforcement: whatever the real project in tasks/automations.ts
// grows to contain, every emitted JS file must parse. Individual profile
// tests assert *content*; this suite guarantees *validity* for files those
// tests don't cover.
describe("compiled project output", () => {
  const files = compileProjectFiles(automations, {
    repo: { owner: "acme", repo: "automations" },
  });

  for (const file of files.filter((f) => f.filename.endsWith(".js"))) {
    it(`${file.filename} parses as valid JavaScript`, () => {
      expectValidJs(file.content);
    });
  }
});
