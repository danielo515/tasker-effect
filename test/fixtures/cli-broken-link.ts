/** Fixture entry module: a Project whose PerformTask reference is dangling. */
import { Action, Project, Task } from "../../src/index.js";

const weatherCheck = new Task({
  name: "Weather Check",
  actions: [Action.flash("weather")],
});

export default new Project({
  name: "Broken",
  tasks: [
    new Task({
      name: "Caller",
      actions: [Action.performTask(weatherCheck)],
    }),
  ],
});
