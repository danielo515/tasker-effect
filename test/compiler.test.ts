import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  type Action as ActionType,
  type Trigger as TriggerType,
  Action,
  ConditionOp,
  Trigger,
  Task,
  Profile,
  Project,
  cond,
} from "../src/profile.js";
import { Interpolated, Secret, fmt, secret, v } from "../src/profile.js";
import {
  CompileError,
  SECRETS_FILENAME,
  TaskerCompiler,
  collectProjectSecrets,
  compileSecretsJson,
  compileTaskToJs,
  compileProfileFiles,
  compileProjectFiles,
  conditionExpr,
  describeTrigger,
  emitAction,
  emitText,
  slugify,
} from "../src/compiler.js";

const TEST_REPO = { owner: "acme", repo: "automations" } as const;

const expectValidJs = (code: string) => {
  // Throws SyntaxError if the emitted code does not parse (never invoked).
  // oxlint-disable-next-line typescript/no-implied-eval -- parse-only guard on generated output, never invoked
  expect(() => new Function(code)).not.toThrow();
};

describe("compileTaskToJs", () => {
  it("emits Tasker API calls for each action", () => {
    const task = new Task({
      name: "Morning Routine",
      actions: [
        Action.flash("Good morning!"),
        Action.setVolume("media", 5),
        Action.say("Time to wake up"),
        Action.setGlobal("%MODE", "day"),
      ],
    });

    const jsSource = compileTaskToJs(task);

    expect(jsSource).toContain('flash("Good morning!");');
    expect(jsSource).toContain("mediaVol(5, false, false);");
    expect(jsSource).toContain('say("Time to wake up"');
    expect(jsSource).toContain('setGlobal("MODE", "day");');
    expect(jsSource).toContain('"use strict";');
    expectValidJs(jsSource);
  });

  it("escapes quotes and newlines in strings", () => {
    const task = new Task({
      name: "Escapes",
      actions: [Action.flash('He said "hi"\nand left')],
    });
    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain('flash("He said \\"hi\\"\\nand left");');
    expectValidJs(jsSource);
  });

  it("compiles conditionals with else branches", () => {
    const task = new Task({
      name: "Battery Check",
      actions: [
        Action.when(
          cond("%BATT", "lt", "20"),
          [Action.flash("Low battery"), Action.setWifi(false)],
          [Action.flash("All good")]
        ),
      ],
    });

    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain('if (parseFloat(global("BATT")) < parseFloat("20")) {');
    expect(jsSource).toContain("} else {");
    expect(jsSource).toContain("setWifi(false);");
    expectValidJs(jsSource);
  });

  it("compiles HTTP requests to synchronous XHR", () => {
    const task = new Task({
      name: "Fetch Weather",
      actions: [
        Action.http("GET", "https://example.com/weather", {
          headers: { Accept: "application/json" },
          outputGlobal: "%WEATHER",
        }),
      ],
    });

    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain('xhr.open("GET", "https://example.com/weather", false);');
    expect(jsSource).toContain('xhr.setRequestHeader("Accept", "application/json");');
    expect(jsSource).toContain('setGlobal("WEATHER", __out);');
    expectValidJs(jsSource);
  });

  it("shell output lands in a global variable", () => {
    const task = new Task({
      name: "Uptime",
      actions: [Action.shell("uptime", { outputGlobal: "%UPTIME" })],
    });
    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain('__out = shell("uptime", false, 30);');
    expect(jsSource).toContain('setGlobal("UPTIME"');
    expectValidJs(jsSource);
  });

  it("display and mode actions map to their Tasker functions", () => {
    const task = new Task({
      name: "Context Setup",
      actions: [
        Action.setCarMode(true),
        Action.setNightMode(false),
        Action.stayOn("any"),
        Action.setAutoRotate(true),
        Action.setAutoBrightness(false),
        Action.displayTimeout({ minutes: 30, seconds: 15 }),
      ],
    });
    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain("carMode(true);");
    expect(jsSource).toContain("nightMode(false);");
    expect(jsSource).toContain('stayOn("any");');
    expect(jsSource).toContain("displayAutoRotate(true);");
    expect(jsSource).toContain("displayAutoBright(false);");
    expect(jsSource).toContain("displayTimeout(0, 30, 15);");
    expectValidJs(jsSource);
  });

  it("raw JavaScript is inserted verbatim", () => {
    const task = new Task({
      name: "Custom",
      actions: [Action.js("var x = 1;\nflash(String(x));")],
    });
    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain("var x = 1;");
    expectValidJs(jsSource);
  });

  it("wraps everything in an error handler that flashes", () => {
    const task = new Task({ name: "T", actions: [Action.flash("x")] });
    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain("catch (err)");
    expect(jsSource).toContain('flash("Task \\"T\\" failed: " + err);');
  });
});

describe("compileProfileFiles", () => {
  it("emits enter and exit files", () => {
    const profile = new Profile({
      name: "Home WiFi",
      triggers: [Trigger.wifiConnected("MyNetwork")],
      enter: new Task({ name: "Arrive", actions: [Action.flash("Welcome home")] }),
      exit: new Task({ name: "Leave", actions: [Action.flash("Goodbye")] }),
    });

    const files = compileProfileFiles(profile);
    expect(files.map((f) => f.filename)).toEqual([
      "home-wifi.enter.js",
      "home-wifi.exit.js",
    ]);
    for (const file of files) expectValidJs(file.content);
  });
});

describe("compileProjectFiles", () => {
  it("bundles profiles, tasks and a setup README", () => {
    const project = new Project({
      name: "My Automations",
      profiles: [
        new Profile({
          name: "Low Battery",
          triggers: [Trigger.batteryLevel(0, 20)],
          enter: new Task({
            name: "Save Power",
            actions: [Action.setWifi(false)],
          }),
        }),
      ],
      tasks: [
        new Task({ name: "Greet", actions: [Action.flash("Hi")] }),
      ],
    });

    const files = compileProjectFiles(project, { repo: TEST_REPO });
    const names = files.map((f) => f.filename);
    expect(names).toContain("low-battery.enter.js");
    expect(names).toContain("greet.js");
    expect(names).toContain("README.md");

    const readme = files.find((f) => f.filename === "README.md");
    expect(readme?.content).toContain("Battery Level from 0% to 20%");
    expect(readme?.content).toContain("low-battery.enter.js");
  });
});

describe("interpolation", () => {
  const API_KEY = secret("OPENWEATHER_KEY", "OpenWeather API key");

  it("fmt merges literals, flattens nesting and returns plain strings without refs", () => {
    expect(fmt`plain ${"text"} only`).toBe("plain text only");
    const inner = fmt`k=${API_KEY}`;
    const outer = fmt`pre ${inner} post ${1}${2}`;
    expect(outer).toBeInstanceOf(Interpolated);
    expect((outer as Interpolated).parts).toEqual(["pre k=", API_KEY, " post 12"]);
  });

  it("emitText compiles literals, secrets, variables and interpolations", () => {
    expect(emitText("hi")).toBe('"hi"');
    expect(emitText(API_KEY)).toBe('global("OPENWEATHER_KEY")');
    expect(emitText(v("%TEMPERATURE"))).toBe('global("TEMPERATURE")');
    expect(emitText(v("myvar"))).toBe('local("myvar")');
    expect(emitText(fmt`Temp: ${v("TEMPERATURE")} °C`)).toBe(
      '"Temp: " + global("TEMPERATURE") + " °C"'
    );
  });

  it("interpolated action fields compile to concatenations, not %NAME literals", () => {
    const task = new Task({
      name: "Weather",
      actions: [
        Action.flash(fmt`Temp: ${v("TEMPERATURE")} °C`),
        Action.http("GET", fmt`https://api.example.com?key=${API_KEY}`, {
          headers: { Authorization: fmt`Bearer ${API_KEY}` },
        }),
      ],
    });
    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain('flash("Temp: " + global("TEMPERATURE") + " °C");');
    expect(jsSource).toContain(
      'xhr.open("GET", "https://api.example.com?key=" + global("OPENWEATHER_KEY"), false);'
    );
    expect(jsSource).toContain(
      'xhr.setRequestHeader("Authorization", "Bearer " + global("OPENWEATHER_KEY"));'
    );
    expect(jsSource).not.toContain("%TEMPERATURE");
    expectValidJs(jsSource);
  });

  it("a bare Secret is a whole field value and a condition variable", () => {
    const task = new Task({
      name: "Copy",
      actions: [
        Action.setGlobal("COPY", API_KEY),
        Action.when(cond(API_KEY, "isSet"), [Action.flash("have key")]),
      ],
    });
    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain('setGlobal("COPY", global("OPENWEATHER_KEY"));');
    expect(jsSource).toContain(
      'if ((global("OPENWEATHER_KEY") !== undefined && global("OPENWEATHER_KEY") !== "")) {'
    );
    expectValidJs(jsSource);
  });

  it("Action.js splices refs as expressions", () => {
    const task = new Task({
      name: "Raw",
      actions: [Action.js(fmt`var key = ${API_KEY};\nflash(key);`)],
    });
    const jsSource = compileTaskToJs(task);
    expect(jsSource).toContain('var key = global("OPENWEATHER_KEY");');
    expectValidJs(jsSource);
  });
});

describe("secrets", () => {
  const API_KEY = secret("OPENWEATHER_KEY", "OpenWeather API key");
  const weatherTask = new Task({
    name: "Weather",
    actions: [
      Action.http("GET", fmt`https://api.example.com?key=${API_KEY}`, {
        outputGlobal: "%WEATHER_JSON",
      }),
    ],
  });

  it("secret() normalizes the leading % and validates the name", () => {
    expect(secret("%API_KEY", "key").name).toBe("API_KEY");
    expect(() => secret("lowercase", "key")).toThrow();
  });

  it("collectProjectSecrets finds inline uses across profiles and tasks", () => {
    const HA_TOKEN = secret("HOME_ASSISTANT_TOKEN", "HA long-lived token");
    const project = new Project({
      name: "P",
      profiles: [
        new Profile({
          name: "Prof",
          triggers: [Trigger.time({ hour: 7, minute: 0 })],
          enter: new Task({
            name: "Enter",
            // Nested inside If and a header record — the walk must reach both.
            actions: [
              Action.when(cond("%READY", "isSet"), [
                Action.http("POST", "https://ha.local/api", {
                  headers: { Authorization: fmt`Bearer ${HA_TOKEN}` },
                }),
              ]),
            ],
          }),
        }),
      ],
      tasks: [weatherTask],
    });

    const secrets = collectProjectSecrets(project);
    expect(secrets.map((s) => s.name)).toEqual([
      "HOME_ASSISTANT_TOKEN",
      "OPENWEATHER_KEY",
    ]);
  });

  it("declared but unused secrets are not emitted", () => {
    // UNUSED_KEY is constructed but never referenced by any action.
    secret("UNUSED_KEY", "never referenced");
    const project = new Project({ name: "P", tasks: [weatherTask] });
    expect(collectProjectSecrets(project).map((s) => s.name)).toEqual([
      "OPENWEATHER_KEY",
    ]);
  });

  it("the same name used with the same description deduplicates", () => {
    const again = new Secret({
      name: "OPENWEATHER_KEY",
      description: "OpenWeather API key",
    });
    const project = new Project({
      name: "P",
      tasks: [
        weatherTask,
        new Task({ name: "B", actions: [Action.setGlobal("K", again)] }),
      ],
    });
    expect(collectProjectSecrets(project)).toHaveLength(1);
  });

  it("conflicting descriptions for the same secret fail compilation", () => {
    const conflicting = secret("OPENWEATHER_KEY", "something else entirely");
    const project = new Project({
      name: "P",
      tasks: [
        weatherTask,
        new Task({ name: "B", actions: [Action.flash(fmt`${conflicting}`)] }),
      ],
    });
    expect(() => collectProjectSecrets(project)).toThrow(CompileError);
  });

  it("compileProjectFiles emits secrets.json from inline uses", () => {
    const project = new Project({ name: "P", tasks: [weatherTask] });
    const files = compileProjectFiles(project, { repo: TEST_REPO });
    const manifest = files.find((f) => f.filename === SECRETS_FILENAME);
    expect(manifest?.kind).toBe("secrets-json");
    expect(JSON.parse(manifest!.content)).toEqual([
      { name: "OPENWEATHER_KEY", description: "OpenWeather API key" },
    ]);
  });

  it("secrets.json is emitted even when no secrets are used", () => {
    const project = new Project({
      name: "Empty",
      tasks: [new Task({ name: "T", actions: [Action.flash("x")] })],
    });
    const files = compileProjectFiles(project, { repo: TEST_REPO });
    const manifest = files.find((f) => f.filename === SECRETS_FILENAME);
    expect(JSON.parse(manifest!.content)).toEqual([]);
  });

  it("a secret used only in a trigger condition is collected and described by name", () => {
    const KEY = secret("TRIGGER_ONLY_KEY", "only used in a trigger");
    const trigger = Trigger.variable(cond(KEY, "isSet"));
    const project = new Project({
      name: "P",
      profiles: [
        new Profile({
          name: "Prof",
          triggers: [trigger],
          enter: new Task({ name: "Enter", actions: [Action.flash("x")] }),
        }),
      ],
    });

    expect(collectProjectSecrets(project).map((s) => s.name)).toEqual([
      "TRIGGER_ONLY_KEY",
    ]);

    const description = describeTrigger(trigger);
    expect(description).toContain("%TRIGGER_ONLY_KEY");
    expect(description).not.toContain("_tag");
  });

  it("compileSecretsJson output is stable and sorted by name", () => {
    const project = new Project({
      name: "P",
      tasks: [
        new Task({
          name: "T",
          actions: [
            Action.flash(fmt`${secret("ZEBRA", "z")}${secret("ALPHA", "a")}`),
          ],
        }),
      ],
    });
    expect(
      JSON.parse(compileSecretsJson(project)).map((s: Secret) => s.name)
    ).toEqual(["ALPHA", "ZEBRA"]);
  });
});

describe("task references", () => {
  const weather = new Task({
    name: "Weather Check",
    actions: [Action.flash("weather")],
  });

  it("DSL performTask routes through the dispatcher", () => {
    const caller = new Task({
      name: "Caller",
      actions: [Action.performTask(weather, { priority: 9 })],
    });
    const jsSource = compileTaskToJs(caller);
    expect(jsSource).toContain(
      'performTask("TE Dispatch", 9, "Weather Check", undefined);'
    );
    expectValidJs(jsSource);
  });

  it("performTaskerTask compiles to a direct call with parameters", () => {
    const caller = new Task({
      name: "Caller",
      actions: [
        Action.performTaskerTask("Hand Made", {
          priority: 7,
          parameterOne: "now",
        }),
      ],
    });
    const jsSource = compileTaskToJs(caller);
    expect(jsSource).toContain('performTask("Hand Made", 7, "now", undefined);');
    expectValidJs(jsSource);
  });

  it("project compilation fails on dangling DSL task references", () => {
    const project = new Project({
      name: "Broken",
      profiles: [
        new Profile({
          name: "Morning Routine",
          triggers: [Trigger.time({ hour: 7, minute: 0 })],
          enter: new Task({
            name: "Morning Enter",
            actions: [
              Action.when(cond("%READY", "isSet"), [
                Action.performTask(weather),
              ]),
            ],
          }),
        }),
      ],
      tasks: [new Task({ name: "Other Task", actions: [Action.flash("x")] })],
    });

    let error: unknown;
    try {
      compileProjectFiles(project, { repo: TEST_REPO });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CompileError);
    const message = (error as CompileError).message;
    expect(message).toContain('Profile "Morning Routine"');
    expect(message).toContain('"Morning Enter"');
    expect(message).toContain('unknown task "Weather Check"');
    expect(message).toContain('Valid targets: "Other Task"');
  });

  it.effect("TaskerCompiler.compileProject surfaces the linker CompileError", () =>
    Effect.gen(function* () {
      const project = new Project({
        name: "Broken",
        tasks: [
          new Task({
            name: "Caller",
            actions: [Action.performTask(weather)],
          }),
        ],
      });
      const program = Effect.gen(function* () {
        const compiler = yield* TaskerCompiler;
        return yield* compiler.compileProject(project, { repo: TEST_REPO });
      });
      const error = yield* program.pipe(
        Effect.flip,
        Effect.provide(TaskerCompiler.Default)
      );
      expect(error).toBeInstanceOf(CompileError);
      expect(error.message).toContain('unknown task "Weather Check"');
    })
  );

  it("valid DSL references compile, including UI-task escape hatches", () => {
    const project = new Project({
      name: "Linked",
      profiles: [
        new Profile({
          name: "Morning Routine",
          triggers: [Trigger.time({ hour: 7, minute: 0 })],
          enter: new Task({
            name: "Morning Enter",
            actions: [
              Action.performTask(weather),
              // UI-created tasks are not validated: they only exist on-device.
              Action.performTaskerTask("Hand Made"),
            ],
          }),
        }),
      ],
      tasks: [weather],
    });
    expect(() => compileProjectFiles(project, { repo: TEST_REPO })).not.toThrow();
  });
});

describe("Match coverage", () => {
  const target = new Task({ name: "Target", actions: [Action.flash("t")] });

  const oneOfEveryAction: ReadonlyArray<ActionType> = [
    Action.flash("x"),
    Action.popup("t", "b"),
    Action.say("x"),
    Action.vibrate(100),
    Action.vibratePattern("0,100"),
    Action.setGlobal("%A", "1"),
    Action.setLocal("a", "1"),
    Action.performTask(target),
    Action.performTaskerTask("T"),
    Action.enableTaskerProfile("P"),
    Action.wait(10),
    Action.shell("ls"),
    Action.readFile("/a", "%OUT"),
    Action.writeFile("/a", "x"),
    Action.http("GET", "https://example.com"),
    Action.browseUrl("https://example.com"),
    Action.sendSms("123", "hi"),
    Action.setWifi(true),
    Action.setBluetooth(true),
    Action.setAirplaneMode(false),
    Action.setMobileData(true),
    Action.setAutoSync(true),
    Action.setVolume("media", 3),
    Action.mediaControl("pause"),
    Action.musicPlay("/a.mp3"),
    Action.musicStop(),
    Action.setClip("x"),
    Action.setWallpaper("/w.png"),
    Action.launchApp("app"),
    Action.sendIntent("a", "activity"),
    Action.silentMode("on"),
    Action.goHome(),
    Action.getLocation("gps"),
    Action.setCarMode(true),
    Action.setNightMode(true),
    Action.stayOn("ac"),
    Action.setAutoRotate(true),
    Action.setAutoBrightness(false),
    Action.displayTimeout({ minutes: 10 }),
    Action.js("flash('x')"),
    Action.when(cond("%A", "isSet"), [Action.flash("y")]),
  ];

  it("emitAction handles every action tag", () => {
    for (const action of oneOfEveryAction) {
      const lines = emitAction(action);
      expect(lines.length).toBeGreaterThan(0);
    }
  });

  const oneOfEveryTrigger: ReadonlyArray<TriggerType> = [
    Trigger.time({ hour: 7, minute: 0 }),
    Trigger.location(40, -3, 100),
    Trigger.wifiConnected(),
    Trigger.bluetoothConnected(),
    Trigger.appOpened("app"),
    Trigger.batteryLevel(0, 20),
    Trigger.headsetPlugged("mic"),
    Trigger.power("wireless"),
    Trigger.calendarEntry({ title: "Meeting" }),
    Trigger.receivedText({ kind: "sms" }),
    Trigger.variable(cond("%A", "eq", "1")),
    Trigger.event("Display On"),
    Trigger.state("Power"),
  ];

  it("describeTrigger handles every trigger tag", () => {
    for (const trigger of oneOfEveryTrigger) {
      expect(describeTrigger(trigger).length).toBeGreaterThan(0);
    }
  });

  it("conditionExpr handles every operator", () => {
    for (const op of ConditionOp.literals) {
      expect(conditionExpr(cond("%A", op, "1")).length).toBeGreaterThan(0);
    }
  });
});

describe("TaskerCompiler service", () => {
  it.effect("compileTask returns a CompiledFile", () =>
    Effect.gen(function* () {
      const compiler = yield* TaskerCompiler;
      const file = yield* compiler.compileTask(
        new Task({ name: "Service Task", actions: [Action.flash("via service")] })
      );
      expect(file.filename).toBe("service-task.js");
      expect(file.content).toContain('flash("via service");');
    }).pipe(Effect.provide(TaskerCompiler.Default))
  );
});

describe("helpers", () => {
  it("slugify produces safe file names", () => {
    expect(slugify("Morning Routine!")).toBe("morning-routine");
    expect(slugify("  ")).toBe("task");
  });

  it("describeTrigger formats the popular-profile triggers", () => {
    expect(describeTrigger(Trigger.headsetPlugged())).toBe(
      "State > Hardware > Headset Plugged (Type: Any)"
    );
    expect(describeTrigger(Trigger.power("ac"))).toBe(
      "State > Power > Power (Source: ac)"
    );
    expect(
      describeTrigger(Trigger.calendarEntry({ calendar: "Work", title: "1:1" }))
    ).toBe("State > App > Calendar Entry (Calendar: Work, Title: 1:1)");
    expect(describeTrigger(Trigger.receivedText({ sender: "Boss" }))).toBe(
      "Event > Phone > Received Text (Type: Any, Sender: Boss)"
    );
  });

  it("describeTrigger formats times", () => {
    const description = describeTrigger(
      Trigger.time({ hour: 7, minute: 5 }, { to: { hour: 9, minute: 0 } })
    );
    expect(description).toBe("Time from 07:05 to 09:00");
  });
});
