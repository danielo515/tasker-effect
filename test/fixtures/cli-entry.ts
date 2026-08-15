/** Fixture entry module for CLI tests: default + named compilable exports. */
import { Action, Trigger, Task, Profile, Project } from "../../src/index.js";

/** Named Task export */
export const greet = new Task({
  name: "Greet",
  description: "Say hello",
  actions: [Action.flash("Hi")],
});

/** Named Profile export with enter and exit tasks */
export const nightMode = new Profile({
  name: "Night Mode",
  triggers: [Trigger.time({ hour: 22, minute: 0 })],
  enter: new Task({
    name: "Night On",
    actions: [Action.setVolume("ringer", 1)],
  }),
  exit: new Task({
    name: "Night Off",
    actions: [Action.setVolume("ringer", 5)],
  }),
});

/** Non-compilable exports must be ignored by the scanner */
export const notCompilable = "just a string";
export const alsoIgnored = { name: "looks close", but: "is not a DSL value" };

/** Default Project export */
export default new Project({
  name: "Fixture Project",
  tasks: [
    new Task({ name: "Project Task", actions: [Action.flash("From project")] }),
  ],
});
