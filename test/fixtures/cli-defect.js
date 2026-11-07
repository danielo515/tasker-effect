/**
 * Fixture entry module (plain JS): a Task whose action tag the compiler's
 * `Match.exhaustive` does not know about — schema validation is bypassed to
 * simulate an internal compiler bug, which the CLI must surface as a defect
 * (its real stack), not as "Compilation failed" (which implies a fixable
 * DSL problem).
 *
 * It imports the built `dist/` (not `src/`) so the Task is an instance of
 * the very class the spawned bin checks with `instanceof`; a `src/` copy
 * would be re-decoded through the schema and rejected as a near-miss export
 * before ever reaching the compiler.
 */
import { Task } from "../../dist/index.js";

export default new Task(
  { name: "Broken Task", actions: [{ _tag: "NotARealAction" }] },
  { disableValidation: true }
);
