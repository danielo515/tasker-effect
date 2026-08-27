/** Fixture entry module: two exports that compile to the same filename. */
import { Action, Task } from "../../src/index.js";

export const first = new Task({
  name: "Same Name",
  actions: [Action.flash("first")],
});

export const second = new Task({
  name: "Same Name",
  actions: [Action.flash("second")],
});
