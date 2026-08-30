import { defineConfig } from "vitest/config"
import { withCrapTypescriptVitest } from "@barney-media/crap-typescript-vitest"

// CRAP (Change Risk Anti-Patterns) combines cyclomatic complexity with
// per-function test coverage: complex, under-tested code scores high and
// fails the run. Threshold 8 is deliberately looser than the project's
// 100% coverage requirement — it exists to flag complexity that coverage
// alone doesn't catch, not to duplicate the coverage gate.
export default defineConfig(
  withCrapTypescriptVitest(
    {
      test: {
        coverage: {
          provider: "v8",
          reporter: ["text", "html", "lcov"],
          include: ["src/**/*.ts"],
          exclude: ["src/**/*.d.ts"],
          thresholds: {
            statements: 100,
            branches: 100,
            functions: 100,
            lines: 100,
          },
        },
      },
    },
    {
      threshold: 8,
      format: "text",
      failuresOnly: true,
    },
  ),
)
