import { describe, expect, it } from "@effect/vitest";
import { Either, ParseResult, Schema } from "effect";
import {
  Action,
  ActionSchema,
  Comparison,
  Condition,
  Presence,
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
  it("interpolated actions survive a JSON encode/decode round-trip", () => {
    const API_KEY = secret("OPENWEATHER_KEY", "OpenWeather API key");
    const action = Action.flash(fmt`key=${API_KEY} temp=${v("TEMPERATURE")}`);

    const encoded = JSON.parse(
      JSON.stringify(Schema.encodeUnknownSync(ActionSchema)(action))
    );
    const decoded = Schema.decodeUnknownSync(ActionSchema)(encoded);

    expect(decoded).toEqual(action);
    expect((decoded as { text: Interpolated }).text).toBeInstanceOf(Interpolated);
  });

  it("a bare Secret field value round-trips", () => {
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
  it("flash creates a tagged action with defaults", () => {
    const action = Action.flash("Hello");
    expect(action._tag).toBe("Flash");
    expect(action.text).toBe("Hello");
    expect(action.long).toBe(false);
  });

  it("setGlobal strips the % prefix", () => {
    const action = Action.setGlobal("%MODE", "night");
    expect(action.name).toBe("MODE");
  });

  it("http defaults headers to an empty record", () => {
    const action = Action.http("GET", "https://example.com");
    expect(action.headers).toEqual({});
    expect(action.outputGlobal).toBeUndefined();
  });

  it("http sets body and outputGlobal when provided", () => {
    const action = Action.http("POST", "https://example.com", {
      body: "payload",
      outputGlobal: "RESPONSE",
    });
    expect(action.body).toBe("payload");
    expect(action.outputGlobal).toBe("RESPONSE");
  });

  it("say sets engine and voice when provided", () => {
    const action = Action.say("hi", { engine: "google", voice: "en-us" });
    expect(action.engine).toBe("google");
    expect(action.voice).toBe("en-us");
  });

  it("launchApp sets data when provided", () => {
    const action = Action.launchApp("app", { data: "extra" });
    expect(action.data).toBe("extra");
  });

  it("sendIntent sets every optional field when provided", () => {
    const action = Action.sendIntent("android.intent.action.VIEW", "activity", {
      pkg: "com.example",
      cls: "MainActivity",
      category: "android.intent.category.DEFAULT",
      data: "content://x",
      mimeType: "text/plain",
      extras: ["a=1"],
    });
    expect(action.pkg).toBe("com.example");
    expect(action.cls).toBe("MainActivity");
    expect(action.category).toBe("android.intent.category.DEFAULT");
    expect(action.data).toBe("content://x");
    expect(action.mimeType).toBe("text/plain");
    expect(action.extras).toEqual(["a=1"]);
  });

  it("when nests actions recursively", () => {
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

  it("validation rejects invalid values at construction", () => {
    expect(() => Action.vibrate(-5)).toThrow();
    expect(() => Action.flash("")).toThrow();
    expect(() => Action.vibratePattern("abc")).toThrow();
  });
});

describe("cond", () => {
  it("pairs a comparison operator with its required value", () => {
    const condition = cond("%BATT", "lt", "20");
    expect(condition).toBeInstanceOf(Comparison);
    expect(condition).toEqual(
      new Comparison({ variable: "BATT", op: "lt", value: "20" })
    );
  });

  it("builds a value-less Presence for a presence operator", () => {
    const condition = cond("%BATT", "isSet");
    expect(condition).toBeInstanceOf(Presence);
    expect(condition).toEqual(new Presence({ variable: "BATT", op: "isSet" }));
    // There is no code path that reaches Comparison without a comparand, so
    // a presence condition never carries an empty `value` to compare against.
    expect("value" in condition).toBe(false);
  });

  it("accepts a Secret in the variable position", () => {
    const API_KEY = secret("OPENWEATHER_KEY", "OpenWeather API key");
    expect(cond(API_KEY, "isSet").variable).toBe(API_KEY);
  });

  it("encodes both members without a _tag discriminator", () => {
    const encode = Schema.encodeSync(Condition);
    expect(encode(cond("%BATT", "lt", "20"))).toEqual({
      variable: "BATT",
      op: "lt",
      value: "20",
    });
    expect(encode(cond("%BATT", "isSet"))).toEqual({
      variable: "BATT",
      op: "isSet",
    });
  });
});

describe("typed task and profile references", () => {
  const weather = new Task({
    name: "Weather Check",
    actions: [Action.flash("weather")],
  });

  it("performTask takes a Task object and stores only its name", () => {
    const action = Action.performTask(weather, { priority: 10 });
    expect(action._tag).toBe("PerformTask");
    expect(action.taskName).toBe("Weather Check");
    expect(action.priority).toBe(10);
    // The action stays flat: no embedded Task object.
    expect(Object.keys(action)).not.toContain("task");
  });

  it("performTaskerTask references UI-created tasks by name with parameters", () => {
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

  it("enableProfile takes a Profile object; enableTaskerProfile a name", () => {
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
  it("time trigger validates hours and minutes", () => {
    const trigger = Trigger.time(
      { hour: 7, minute: 0 },
      { to: { hour: 9, minute: 30 }, days: ["monday", "friday"] }
    );
    expect(trigger._tag).toBe("TimeTrigger");
    expect(trigger.from).toBeInstanceOf(TimeOfDay);
    expect(() => Trigger.time({ hour: 25, minute: 0 })).toThrow();
  });

  it("time trigger sets repeatMinutes when provided", () => {
    const trigger = Trigger.time({ hour: 7, minute: 0 }, { repeatMinutes: 30 });
    expect(trigger.repeatMinutes).toBe(30);
  });

  it("battery trigger validates range", () => {
    expect(() => Trigger.batteryLevel(0, 150)).toThrow();
  });

  it("battery trigger rejects a reversed range (from > to)", () => {
    expect(() => Trigger.batteryLevel(60, 40)).toThrow(ParseResult.ParseError);
  });

  it("location trigger validates coordinates", () => {
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

  it("Task.make works as advertised", () => {
    const t = Task.make({
      name: "T",
      actions: [Action.flash("x")],
    });
    expect(t.name).toBe("T");
  });

  it("requires at least one action", () => {
    const result = Schema.decodeUnknownEither(Task)({
      name: "Empty",
      actions: [],
    });
    expect(Either.isLeft(result)).toBe(true);
  });

  it("profile bundles triggers with tasks", () => {
    const profile = new Profile({
      name: "Weekday mornings",
      triggers: [Trigger.time({ hour: 7, minute: 0 })],
      enter: morning,
    });
    expect(profile.enabled).toBe(true);
    expect(profile.exit).toBeUndefined();
  });

  it("project defaults to empty collections", () => {
    const project = new Project({ name: "My Automations" });
    expect(project.profiles).toEqual([]);
    expect(project.tasks).toEqual([]);
  });

  it.effect("decodeTask round-trips encoded data including nested If", () =>
    Effect.gen(function* () {
      const original = new Task({
        name: "Nested",
        actions: [
          Action.when(cond("BATT", "lt", "20"), [Action.flash("low")]),
        ],
      });
      const encoded = yield* Schema.encode(Task)(original);
      const decoded = yield* decodeTask(encoded);
      expect(decoded.name).toBe("Nested");
      const first = decoded.actions[0];
      expect(first._tag).toBe("If");
      expect((first as If).then[0]?._tag).toBe("Flash");
    })
  );
});

describe("variable helpers", () => {
  it("distinguishes global from local names", () => {
    expect(isGlobalVariable("%BATT")).toBe(true);
    expect(isGlobalVariable("counter")).toBe(false);
    expect(variableName("%WIFI")).toBe("WIFI");
    expect(variableName("plain")).toBe("plain");
  });
});
