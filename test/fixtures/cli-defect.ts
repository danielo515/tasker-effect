/**
 * Fixture entry module: a Task whose action tag the compiler's
 * `Match.exhaustive` does not know about — schema validation is bypassed to
 * simulate an internal compiler bug, which the CLI must surface as a defect
 * (its real stack), not as "Compilation failed" (which implies a fixable
 * DSL problem).
 */
import { Task } from "../../src/index.js";

export default new Task(
  { name: "Broken Task", actions: [{ _tag: "NotARealAction" } as never] },
  { disableValidation: true }
);
