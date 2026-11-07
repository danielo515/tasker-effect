import { defineConfig } from "vitest/config"

// Coverage is a floor, not a target: the thresholds catch untested new code
// without forcing coverage-only tests. Complexity is gated separately by
// oxlint's `complexity` rule (see .oxlintrc.json).
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 85,
        branches: 85,
      },
    },
  },
})
