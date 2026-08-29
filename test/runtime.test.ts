import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Effect } from "effect"
import { runInTasker } from "../src/runtime.js"

// runInTasker hardcodes Effect.provide(Tasker.Default) — it isn't
// parameterized with a Layer. Tasker.Default's live implementation looks up
// the Tasker builtins (flash, exit, ...) as globalThis properties at call
// time, since that's how Tasker actually injects them into its JS
// environment; there's no service boundary to substitute off-device. So
// stubbing those globals is the only way to exercise the live success/
// failure/exit paths here — the same technique test/tasker-api.test.ts
// already uses for the same Tasker.Default layer.
const g = globalThis as Record<string, unknown>

describe("runInTasker", () => {
  afterEach(() => {
    delete g.flash
    delete g.exit
  })

  it.effect("resolves with the program's success value", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() => runInTasker(Effect.succeed(42)))
      expect(result).toBe(42)
    })
  )

  it.effect("does not call exit() when exitWhenDone is not set", () =>
    Effect.gen(function* () {
      const exit = vi.fn()
      g.exit = exit
      yield* Effect.promise(() => runInTasker(Effect.succeed("ok")))
      expect(exit).not.toHaveBeenCalled()
    })
  )

  it.effect("calls Tasker's exit() when exitWhenDone is true", () =>
    Effect.gen(function* () {
      const exit = vi.fn()
      g.exit = exit
      yield* Effect.promise(() =>
        runInTasker(Effect.succeed("ok"), { exitWhenDone: true })
      )
      expect(exit).toHaveBeenCalledTimes(1)
    })
  )

  it.effect("swallows exit() failures when the builtin is unavailable off-device", () =>
    Effect.gen(function* () {
      delete g.exit
      const result = yield* Effect.promise(() =>
        runInTasker(Effect.succeed("ok"), { exitWhenDone: true })
      )
      expect(result).toBe("ok")
    })
  )

  it.effect("flashes the failure and rethrows so the promise rejects", () =>
    Effect.gen(function* () {
      const flash = vi.fn()
      g.flash = flash
      const exit = yield* Effect.promise(() =>
        runInTasker(Effect.fail("boom")).then(
          () => undefined,
          (error: unknown) => error
        )
      )
      expect(exit).toBeTruthy()
      expect(flash).toHaveBeenCalledTimes(1)
      expect(flash.mock.calls[0]?.[0]).toContain("tasker-effect:")
    })
  )

  it.effect("swallows flash() failures when flash itself throws off-device", () =>
    Effect.gen(function* () {
      delete g.flash
      const error = yield* Effect.promise(() =>
        runInTasker(Effect.fail("boom")).then(
          () => undefined,
          (e: unknown) => e
        )
      )
      expect(error).toBeTruthy()
    })
  )
})
