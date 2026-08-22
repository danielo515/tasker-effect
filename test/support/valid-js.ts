import { expect } from "@effect/vitest";

/** Assert that a string of emitted code parses as valid JavaScript. */
export const expectValidJs = (code: string): void => {
  // Throws SyntaxError if the emitted code does not parse (never invoked).
  // oxlint-disable-next-line typescript/no-implied-eval -- parse-only guard on generated output, never invoked
  expect(() => new Function(code)).not.toThrow();
};
