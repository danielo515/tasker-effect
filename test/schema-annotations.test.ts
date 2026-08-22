import { describe, expect, it } from "@effect/vitest";
import { Option, Schema, SchemaAST } from "effect";
import {
  CalendarEntryTrigger,
  HeadsetPluggedTrigger,
  PowerTrigger,
  ReceivedTextTrigger,
  SetAutoBrightness,
  SetAutoRotate,
  SetCarMode,
  SetDisplayTimeout,
  SetNightMode,
  SetStayOn,
} from "../src/profile.js";

// The docs() helper in profile.ts is loosely typed (annotating a class with
// its own Type inside the extends clause is circular, TS2310), so this test
// is what enforces that every documented class has a description and that
// each example actually satisfies its schema.
const documented = [
  SetCarMode,
  SetNightMode,
  SetStayOn,
  SetAutoRotate,
  SetAutoBrightness,
  SetDisplayTimeout,
  HeadsetPluggedTrigger,
  PowerTrigger,
  CalendarEntryTrigger,
  ReceivedTextTrigger,
] as const;

const typeSide = (schema: (typeof documented)[number]): SchemaAST.AST => {
  const ast = schema.ast;
  return ast._tag === "Transformation" ? ast.to : ast;
};

describe("schema documentation annotations", () => {
  for (const schema of documented) {
    it(`${schema.name} has a description`, () => {
      const description = SchemaAST.getDescriptionAnnotation(typeSide(schema));
      expect(Option.isSome(description)).toBe(true);
      expect(Option.getOrThrow(description).length).toBeGreaterThan(0);
    });

    it(`${schema.name} has examples that satisfy the schema`, () => {
      const examples = SchemaAST.getExamplesAnnotation(typeSide(schema));
      expect(Option.isSome(examples)).toBe(true);
      const decode = Schema.decodeUnknownSync(
        schema as Schema.Schema<unknown>
      );
      for (const example of Option.getOrThrow(examples)) {
        expect(() => decode(example)).not.toThrow();
      }
    });
  }
});
