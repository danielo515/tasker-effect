import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";
import {
  Action,
  ActionSchema,
  Trigger,
  Task,
  Profile,
  Project,
  TimeOfDay,
  cond,
  decodeTask,
  fmt,
  isGlobalVariable,
  secret,
  v,
  variableName,
  If,
  Interpolated,
} from "../src/profile.js";
import { Effect } from "effect";

describe("interpolation values", () => {
  test("interpolated actions survive a JSON encode/decode round-trip", () => {
    const API_KEY = secret("OPENWEATHER_KEY", "OpenWeather API key");
    const action = Action.flash(fmt`key=${API_KEY} temp=${v("TEMPERATURE")}`);

    const encoded = JSON.parse(
      JSON.stringify(Schema.encodeUnknownSync(ActionSchema)(action))
    );
    const decoded = Schema.decodeUnknownSync(ActionSchema)(encoded);

    expect(decoded).toEqual(action);
    expect((decoded as { text: Interpolated }).text).toBeInstanceOf(Interpolated);
  });

  test("a bare Secret field value round-trips", () => {
    const API_KEY = secret("OPENWEATHER_KEY", "OpenWeather API key");
    const action = Action.setGlobal("COPY", API_KEY);
    const encoded = JSON.parse(
      JSON.stringify(Schema.encodeUnknownSync(ActionSchema)(action))
    );
    const decoded = Schema.decodeUnknownSync(ActionSchema)(encoded);
    expect(decoded).toEqual(action);
  });
});

describe("Action builders", () => {
  test("flash creates a tagged action with defaults", () => {
    const action = Action.flash("Hello");
    expect(action._tag).toBe("Flash");
    expect(action.text).toBe("Hello");
    expect(action.long).toBe(false);
  });

  test("setGlobal strips the % prefix", () => {
    const action = Action.setGlobal("%MODE", "night");
    expect(action.name).toBe("MODE");
  });

  test("http defaults headers to an empty record", () => {
    const action = Action.http("GET", "https://example.com");
    expect(action.headers).toEqual({});
    expect(action.outputGlobal).toBeUndefined();
  });

  test("when nests actions recursively", () => {
    const action = Action.when(
      cond("%BATT", "lt", "20"),
      [Action.flash("Low battery"), Action.setWifi(false)],
      [Action.flash("Battery fine")]
    );
    expect(action._tag).toBe("If");
    expect(action.then).toHaveLength(2);
    expect(action.orElse).toHaveLength(1);
    expect(action.condition.variable).toBe("BATT");
  });

  test("validation rejects invalid values at construction", () => {
    expect(() => Action.vibrate(-5)).toThrow();
    expect(() => Action.flash("")).toThrow();
    expect(() => Action.vibratePattern("abc")).toThrow();
  });
});

describe("typed task and profile references", () => {
  const weather = new Task({
    name: "Weather Check",
    actions: [Action.flash("weather")],
  });

  test("performTask takes a Task object and stores only its name", () => {
    const action = Action.performTask(weather, { priority: 10 });
    expect(action._tag).toBe("PerformTask");
    expect(action.taskName).toBe("Weather Check");
    expect(action.priority).toBe(10);
    // The action stays flat: no embedded Task object.
    expect(Object.keys(action)).not.toContain("task");
  });

  test("performTaskerTask references UI-created tasks by name with parameters", () => {
    const action = Action.performTaskerTask("Hand Made", {
      priority: 7,
      parameterOne: "now",
      parameterTwo: "fast",
    });
    expect(action._tag).toBe("PerformTaskerTask");
    expect(action.taskName).toBe("Hand Made");
    expect(action.parameterOne).toBe("now");
    expect(action.parameterTwo).toBe("fast");
  });

  test("enableProfile takes a Profile object; enableTaskerProfile a name", () => {
    const profile = new Profile({
      name: "Night Mode",
      triggers: [Trigger.time({ hour: 22, minute: 0 })],
      enter: weather,
    });
    const typed = Action.enableProfile(profile, false);
    expect(typed._tag).toBe("EnableProfile");
    expect(typed.profileName).toBe("Night Mode");
    expect(typed.enable).toBe(false);

    const byName = Action.enableTaskerProfile("Hand Made Profile");
    expect(byName._tag).toBe("EnableProfile");
    expect(byName.profileName).toBe("Hand Made Profile");
    expect(byName.enable).toBe(true);
  });
});

describe("Trigger builders", () => {
  test("time trigger validates hours and minutes", () => {
    const trigger = Trigger.time(
      { hour: 7, minute: 0 },
      { to: { hour: 9, minute: 30 }, days: ["monday", "friday"] }
    );
    expect(trigger._tag).toBe("TimeTrigger");
    expect(trigger.from).toBeInstanceOf(TimeOfDay);
    expect(() => Trigger.time({ hour: 25, minute: 0 })).toThrow();
  });

  test("battery trigger validates range", () => {
    expect(() => Trigger.batteryLevel(0, 150)).toThrow();
  });

  test("location trigger validates coordinates", () => {
    expect(() => Trigger.location(200, 0, 100)).toThrow();
  });
});

describe("Task / Profile / Project", () => {
  const morning = new Task({
    name: "Morning Routine",
    actions: [
      Action.flash("Good morning!"),
      Action.setVolume("media", 7),
      Action.say("Time to wake up"),
    ],
  });

  test("Task.make works as advertised", () => {
    const t = Task.make({
      name: "T",
      actions: [Action.flash("x")],
    });
    expect(t.name).toBe("T");
  });

  test("requires at least one action", () => {
    const result = Schema.decodeUnknownEither(Task)({
      name: "Empty",
      actions: [],
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  test("profile bundles triggers with tasks", () => {
    const profile = new Profile({
      name: "Weekday mornings",
      triggers: [Trigger.time({ hour: 7, minute: 0 })],
      enter: morning,
    });
    expect(profile.enabled).toBe(true);
    expect(profile.exit).toBeUndefined();
  });

  test("project defaults to empty collections", () => {
    const project = new Project({ name: "My Automations" });
    expect(project.profiles).toEqual([]);
    expect(project.tasks).toEqual([]);
  });

  test("decodeTask round-trips encoded data including nested If", async () => {
    const original = new Task({
      name: "Nested",
      actions: [
        Action.when(cond("BATT", "lt", "20"), [Action.flash("low")]),
      ],
    });
    const encoded = Schema.encodeSync(Task)(original);
    const decoded = await Effect.runPromise(decodeTask(encoded));
    expect(decoded.name).toBe("Nested");
    const first = decoded.actions[0];
    expect(first._tag).toBe("If");
    expect((first as If).then[0]?._tag).toBe("Flash");
  });
});

describe("variable helpers", () => {
  test("distinguishes global from local names", () => {
    expect(isGlobalVariable("%BATT")).toBe(true);
    expect(isGlobalVariable("counter")).toBe(false);
    expect(variableName("%WIFI")).toBe("WIFI");
    expect(variableName("plain")).toBe("plain");
  });
});
