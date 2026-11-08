import { describe, expect, it } from "@effect/vitest";
import {
  Action,
  Trigger,
  Task,
  Profile,
  Project,
  SCENE_JS_DIR_PLACEHOLDER,
  fmt,
  secret,
} from "../src/profile.js";
import {
  CONFIG_LABEL_FILENAME,
  CONFIG_SCAN_FILENAME,
  CONFIG_TASK_NAME,
  DISPATCHER_FILENAME,
  DISPATCH_TASK_NAME,
  RELEASE_ZIP_FILENAME,
  ROLLING_RELEASE_TAG,
  SCAFFOLD_VERSION,
  SECRETS_FILENAME,
  SHOW_SCENE_TASK_NAME,
  SYNC_PROFILE_NAME,
  SYNC_TASK_NAME,
  TASKER_PROJECT_XML_FILENAME,
  compileDispatcherJs,
  compileProjectFiles,
  configLabelFileJs,
  configScanFileJs,
  releaseZipUrl,
  syncFinishJs,
  syncPrepareJs,
  taskerProjectXml,
} from "../src/compiler.js";
import {
  MENU_HTML_FILENAME,
  MENU_SCENE_FILENAME,
  MENU_SCRIPT_FILENAME,
  MENU_TASK_NAME,
  MENU_TIMEOUT_MS,
  menuSceneJson,
} from "../src/menu.js";

const TEST_REPO = { owner: "acme", repo: "automations" } as const;

const expectValidJs = (code: string) => {
  // Parses without executing: new Function only compiles the body.
  // oxlint-disable-next-line typescript/no-implied-eval -- parse-only guard on generated output, never invoked
  expect(() => new Function(code)).not.toThrow();
};

const makeProject = () =>
  new Project({
    name: "Dispatch Demo",
    profiles: [
      new Profile({
        name: "Morning Routine",
        triggers: [Trigger.time({ hour: 7, minute: 0 })],
        enter: new Task({ name: "Wake", actions: [Action.flash("up")] }),
        exit: new Task({ name: "Sleep", actions: [Action.flash("down")] }),
      }),
      new Profile({
        name: "Enter Only",
        triggers: [Trigger.wifiConnected("Net")],
        enter: new Task({ name: "Arrive", actions: [Action.flash("hello")] }),
      }),
    ],
    tasks: [
      new Task({ name: "Weather Check", actions: [Action.flash("weather")] }),
    ],
  });

describe("compileDispatcherJs", () => {
  it("embeds the profile and task maps with slug filenames", () => {
    const source = compileDispatcherJs(makeProject());

    expect(source).toContain(
      '"Morning Routine": { enter: "morning-routine.enter.js", exit: "morning-routine.exit.js" },'
    );
    expect(source).toContain('"Enter Only": { enter: "enter-only.enter.js" },');
    expect(source).not.toContain("enter-only.exit.js");
    expect(source).toContain('"Weather Check": "weather-check.js",');
    expectValidJs(source);
  });

  it("resolves via %par1/%par2 and falls back to %caller1 profile detection", () => {
    const source = compileDispatcherJs(makeProject());
    expect(source).toContain('local("par1")');
    expect(source).toContain('local("par2")');
    expect(source).toContain('local("caller1")');
    expect(source).toContain("profile=(enter|exit)");
    expect(source).toContain("eval(source);");
    expect(source).toContain("readFile(path)");
  });

  it("uses %TE_JS_DIR with the documented default", () => {
    const source = compileDispatcherJs(makeProject());
    expect(source).toContain('global("TE_JS_DIR")');
    expect(source).toContain('"/sdcard/Tasker/js/"');
  });

  it("escapes names that would break the emitted source", () => {
    const project = new Project({
      name: "Escapes",
      tasks: [
        new Task({
          name: 'He said "run"\nnow',
          actions: [Action.flash("x")],
        }),
      ],
    });
    const source = compileDispatcherJs(project);
    expect(source).toContain('"He said \\"run\\"\\nnow": "he-said-run-now.js",');
    expectValidJs(source);
  });

  it("flashes clear errors for unknown names", () => {
    const source = compileDispatcherJs(makeProject());
    expect(source).toContain("unknown profile or task");
    expect(source).toContain("could not read");
  });

  it("warns (without blocking) when the imported scaffolding is outdated", () => {
    const source = compileDispatcherJs(makeProject());
    expect(source).toContain('parseInt(global("TE_SCAFFOLD_VERSION"), 10)');
    expect(source).toContain(`if (installed < ${SCAFFOLD_VERSION}) {`);
    expect(source).toContain(
      `tasker-effect: scaffolding v${SCAFFOLD_VERSION} required (installed: v" + installed + ") - delete the Tasker Effect project (Delete Contents) and re-import ${TASKER_PROJECT_XML_FILENAME} from the js dir`
    );
    // Warn-only: the check flashes but never returns/exits before dispatch.
    expectValidJs(source);
  });
});

describe("taskerProjectXml", () => {
  const xml = taskerProjectXml({ repo: TEST_REPO });
  const expectValidSnippetJs = (code: string) => {
    // oxlint-disable-next-line typescript/no-implied-eval -- parse-only guard on generated output, never invoked
    expect(() => new Function(code)).not.toThrow();
  };

  it("is a project export: Project element listing the profile and the five tasks", () => {
    expect(xml).toContain('<TaskerData sr="" dvi="1"');
    expect(xml).toContain('<Project sr="proj0" ve="2">');
    expect(xml).toContain("<pids>4</pids>");
    expect(xml).toContain("<tids>1,2,3,5,6</tids>");
    expect(xml.match(/<Task sr="task\d+">/g)).toHaveLength(5);
    expect(xml.match(/<Profile sr="prof\d+" ve="2">/g)).toHaveLength(1);
    for (const name of [
      DISPATCH_TASK_NAME,
      SYNC_TASK_NAME,
      CONFIG_TASK_NAME,
      SHOW_SCENE_TASK_NAME,
      MENU_TASK_NAME,
    ]) {
      expect(xml).toContain(`<nme>${name}</nme>`);
    }
  });

  // Slice out the <Action> element containing a marker, to pin its timeout.
  const actionContaining = (marker: string): string => {
    const start = xml.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    return xml.slice(start, xml.indexOf("</Action>", start));
  };

  it("TE Dispatch runs the dispatcher file (code 131, Auto Exit on)", () => {
    expect(xml).toContain("<code>131</code>");
    expect(xml).toContain(
      '<Str sr="arg0" ve="3">/sdcard/Tasker/js/dispatcher.js</Str>'
    );
    expect(xml).toContain('<Int sr="arg2" val="1"/>');
    // The dispatch action's timeout (arg3) must exceed the config provider's
    // default promptTimeoutMillis (120s), or Tasker kills the script before
    // an unanswered TE Config prompt can fail over to Config.withDefault.
    // It is deliberately generous (600s) so timeout tuning ships in JS
    // (promptTimeoutMillis), never via an XML change forcing a re-import.
    expect(actionContaining("dispatcher.js")).toContain(
      '<Int sr="arg3" val="600"/>'
    );
  });

  it("TE Show Scene shows the Scenes v2 layout JSON passed in %par1 (code 479)", () => {
    const start = xml.indexOf(`<nme>${SHOW_SCENE_TASK_NAME}</nme>`);
    expect(start).toBeGreaterThan(-1);
    const task = xml.slice(start, xml.indexOf("</Task>", start));
    expect(task).toContain("<code>479</code>");
    expect(task).toContain('<Str sr="arg1" ve="3">%par1</Str>');
    // Every other argument keeps Tasker's default, so the layout's own
    // defaultDisplayMode decides how it is shown.
    expect(task).toContain('<Str sr="arg3" ve="3"/>');
    expect(task.match(/<Action sr="act\d+" ve="7">/g)).toHaveLength(1);
  });

  it("the TE Config scan scriptlet gets a generous 600s timeout", () => {
    expect(actionContaining(CONFIG_SCAN_FILENAME)).toContain(
      '<Int sr="arg3" val="600"/>'
    );
  });

  it("the TE Sync profile repeats every 6 hours and runs the TE Sync task", () => {
    expect(xml).toContain(`<nme>${SYNC_PROFILE_NAME}</nme>`);
    expect(xml).toContain("<mid0>2</mid0>");
    expect(xml).toContain("<rep>1</rep>");
    expect(xml).toContain("<repval>6</repval>");
  });

  it("TE Sync downloads the release zip natively and unzips it on HTTP 200", () => {
    const start = xml.indexOf('<Task sr="task2">');
    const task = xml.slice(start, xml.indexOf("</Task>", start));
    expect(task).toContain(`<nme>${SYNC_TASK_NAME}</nme>`);
    expect(
      [...task.matchAll(/<code>(\d+)<\/code>/g)].map((match) => match[1])
    ).toEqual(["129", "339", "422", "129"]);
    const url = `https://github.com/acme/automations/releases/download/${ROLLING_RELEASE_TAG}/${RELEASE_ZIP_FILENAME}`;
    expect(releaseZipUrl(TEST_REPO)).toBe(url);
    expect(task).toContain(`<Str sr="arg2" ve="3">${url}</Str>`);
    expect(task).toContain('<Str sr="arg7" ve="3">%te_zip</Str>');
    expect(task).toContain('<Str sr="arg0" ve="3">%te_zip</Str>');
    expect(task).toContain("<lhs>%http_response_code</lhs>");
    // No sync script download/eval: files never pass through a JS string.
    expect(task).not.toContain("eval(");
    expect(task).not.toContain("writeFile");
    const prepare = syncPrepareJs();
    expect(prepare).toContain('setLocal("te_zip", dir + "tasker-js.zip");');
    expect(prepare).toContain('"/sdcard/Tasker/js/"');
    expectValidSnippetJs(prepare);
    expect(syncFinishJs).toContain('local("http_response_code")');
    expect(syncFinishJs).toContain(`performTask("${CONFIG_TASK_NAME}", 5);`);
    expectValidSnippetJs(syncFinishJs);
  });

  it("TE Sync stamps the scaffolding version on every run", () => {
    const stamp = `setGlobal("TE_SCAFFOLD_VERSION", "${SCAFFOLD_VERSION}");`;
    expect(syncPrepareJs()).toContain(stamp);
    expect(xml).toContain(
      `setGlobal(&quot;TE_SCAFFOLD_VERSION&quot;, &quot;${SCAFFOLD_VERSION}&quot;);`
    );
  });

  it("TE Config's synced scan file has a one-off mode driven by %par1/%par2", () => {
    // One-off mode: prompt for exactly the named global, label from %par2.
    expect(configScanFileJs).toContain('var par1 = local("par1");');
    expect(configScanFileJs).toContain('setLocal("te_missing", par1);');
    expect(configScanFileJs).toContain(
      'if (par2 !== undefined && par2 !== "") setLocal("te_label", par2);'
    );
    // The label lookup prefers the one-off %te_label over secrets.json.
    expect(configLabelFileJs).toContain('var label = local("te_label");');
    expect(configLabelFileJs).toContain(SECRETS_FILENAME);
    expect(configLabelFileJs).toContain('setLocal("te_prompt", label);');
    // Still exactly the five sanctioned tasks.
    expect(xml.match(/<Task sr="task\d+">/g)).toHaveLength(5);
  });

  it("TE Config's synced scan file waits for secrets.json and collects unset secrets", () => {
    expect(configScanFileJs).toContain(SECRETS_FILENAME);
    expect(configScanFileJs).toContain('setLocal("te_missing", missing.join(","));');
    expect(configScanFileJs).toContain("setTimeout(scan, 2000);");
    expectValidSnippetJs(configScanFileJs);
    expectValidSnippetJs(configLabelFileJs);
  });

  it("the XML holds only eval stubs for the TE Config logic", () => {
    // Scan stub: polls for the synced file (first-run race), then evals it.
    const scanStub = xml.slice(
      xml.indexOf(CONFIG_SCAN_FILENAME),
      xml.indexOf("</Action>", xml.indexOf(CONFIG_SCAN_FILENAME))
    );
    expect(scanStub).toContain("setTimeout(boot, 2000);");
    expect(scanStub).toContain("tries &lt; 30");
    expect(scanStub).toContain("eval(src);");
    expect(scanStub).toContain(`${CONFIG_SCAN_FILENAME} missing - run TE Sync`);
    // Label stub: evals the synced file, degrading to the bare name.
    const labelStub = xml.slice(
      xml.indexOf(CONFIG_LABEL_FILENAME),
      xml.indexOf("</Action>", xml.indexOf(CONFIG_LABEL_FILENAME))
    );
    expect(labelStub).toContain("eval(src);");
    expect(labelStub).toContain("local(&quot;te_label&quot;)");
    expect(labelStub).toContain("setLocal(&quot;te_prompt&quot;, fallback);");
    // The moved logic itself is no longer embedded in the XML.
    expect(xml).not.toContain("missing.join");
    expect(xml).not.toContain("declared[i].description");
  });

  it("TE Config prompts via For + Input Dialog with the inline store scriptlet", () => {
    expect(xml).toContain("<code>37</code>"); // If %te_missing Set
    expect(xml).toContain("<lhs>%te_missing</lhs>");
    expect(xml).toContain("<op>12</op>");
    expect(xml).toContain("<code>39</code>"); // For %te_secret in %te_missing
    expect(xml).toContain('<Str sr="arg0" ve="3">%te_secret</Str>');
    expect(xml).toContain("<code>360</code>"); // Input Dialog
    expect(xml).toContain(
      "setGlobal(local(&quot;te_secret&quot;), local(&quot;input&quot;));"
    );
    expect(xml).toContain("<code>40</code>"); // End For
    expect(xml).toContain("<code>38</code>"); // End If
  });

  it("supports a custom dispatcher path, XML-escaped", () => {
    const custom = taskerProjectXml({
      repo: TEST_REPO,
      dispatcherPath: "/a/b & c/dispatcher.js",
    });
    expect(custom).toContain(
      '<Str sr="arg0" ve="3">/a/b &amp; c/dispatcher.js</Str>'
    );
  });

  it("is static scaffolding plus profile wiring, free of task content", () => {
    const projectA = makeProject();
    const projectB = new Project({
      name: "Totally Different",
      tasks: [
        new Task({
          name: "Unique Marker Task",
          actions: [
            Action.flash(fmt`zz ${secret("UNIQUE_MARKER_KEY", "marker secret")}`),
          ],
        }),
      ],
    });

    const xmlA = compileProjectFiles(projectA, { repo: TEST_REPO }).find(
      (file) => file.filename === TASKER_PROJECT_XML_FILENAME
    );
    const xmlB = compileProjectFiles(projectB, { repo: TEST_REPO }).find(
      (file) => file.filename === TASKER_PROJECT_XML_FILENAME
    );

    expect(xmlA).toBeDefined();
    // Neither project has a profile with XML-able triggers, so both get the
    // same static scaffolding.
    expect(xmlA!.content).toBe(xmlB!.content);
    expect(xmlA!.kind).toBe("tasker-xml");
    // No per-task content: standalone task names, compiled JS and secret
    // names must never leak into the XML — only the static scaffolding, the
    // dispatcher pointer, the repo slug and wired profiles' names/triggers.
    for (const marker of [
      "Morning Routine",
      "Weather Check",
      "Unique Marker Task",
      "UNIQUE_MARKER_KEY",
      "morning-routine.enter.js",
      "weather-check.js",
      'flash("up")',
    ]) {
      expect(xmlA!.content).not.toContain(marker);
    }
    // Exactly the sanctioned scaffolding names appear.
    const scaffoldNames = [
      DISPATCH_TASK_NAME,
      SYNC_TASK_NAME,
      CONFIG_TASK_NAME,
      SHOW_SCENE_TASK_NAME,
      MENU_TASK_NAME,
      SYNC_PROFILE_NAME,
    ];
    const namesIn = (xml: string) =>
      [...xml.matchAll(/<nme>([^<]*)<\/nme>/g)].map((match) => match[1]).sort();
    expect(namesIn(xmlA!.content)).toEqual([...scaffoldNames].sort());

    // A wired profile adds only its own name and its generated stub task
    // name; its enter task's name, standalone tasks, compiled JS and
    // secrets stay out.
    const wired = new Project({
      name: "Wired",
      profiles: [
        new Profile({
          name: "Clip Watch",
          triggers: [Trigger.clipboardChanged()],
          enter: new Task({
            name: "Clip Enter Task",
            actions: [
              Action.flash(fmt`c ${secret("WIRED_SECRET_KEY", "wired secret")}`),
            ],
          }),
        }),
      ],
      tasks: [new Task({ name: "Wired Standalone", actions: [Action.flash("w")] })],
    });
    const xmlW = compileProjectFiles(wired, { repo: TEST_REPO }).find(
      (file) => file.filename === TASKER_PROJECT_XML_FILENAME
    )!.content;
    expect(namesIn(xmlW)).toEqual(
      [...scaffoldNames, "Clip Watch", "TE Clip Watch (enter)"].sort()
    );
    for (const marker of [
      "Clip Enter Task",
      "Wired Standalone",
      "WIRED_SECRET_KEY",
      "clip-watch.enter.js",
      "wired-standalone.js",
      'flash("w")',
    ]) {
      expect(xmlW).not.toContain(marker);
    }
  });
});

describe("compileProjectFiles with dispatcher", () => {
  it("includes dispatcher.js, secrets.json and the project XML, and documents them in the README", () => {
    const files = compileProjectFiles(makeProject(), { repo: TEST_REPO });
    const names = files.map((file) => file.filename);
    expect(names).toContain(DISPATCHER_FILENAME);
    expect(names).toContain(SECRETS_FILENAME);
    expect(names).toContain(TASKER_PROJECT_XML_FILENAME);

    const dispatcher = files.find((file) => file.filename === DISPATCHER_FILENAME);
    expect(dispatcher?.kind).toBe("dispatcher-js");

    // The TE Config logic ships as plain .js release assets so the normal
    // sync picks them up with zero changes.
    const scan = files.find((file) => file.filename === CONFIG_SCAN_FILENAME);
    expect(scan?.kind).toBe("scaffold-js");
    expect(scan?.content).toBe(configScanFileJs);
    const label = files.find((file) => file.filename === CONFIG_LABEL_FILENAME);
    expect(label?.kind).toBe("scaffold-js");
    expect(label?.content).toBe(configLabelFileJs);

    const readme = files.find((file) => file.filename === "README.md");
    expect(readme?.content).toContain(DISPATCH_TASK_NAME);
    expect(readme?.content).toContain(TASKER_PROJECT_XML_FILENAME);
    expect(readme?.content).toContain("Import Project");
    expect(readme?.content).toContain("%caller1");
  });
});

describe("TE Menu files", () => {
  const files = compileProjectFiles(makeProject(), { repo: TEST_REPO });
  const file = (name: string) => files.find((f) => f.filename === name)!;

  it("ships the menu script, scene and page as synced assets", () => {
    expect(file(MENU_SCRIPT_FILENAME).kind).toBe("scaffold-js");
    expect(file(MENU_SCENE_FILENAME).kind).toBe("web-asset");
    expect(file(MENU_HTML_FILENAME).kind).toBe("web-asset");
    expect(file(MENU_HTML_FILENAME).content).toContain("TE_MENU_PICK");
  });

  it("the menu script parses and runs the pick in the dispatcher scope", () => {
    const script = file(MENU_SCRIPT_FILENAME).content;
    expectValidJs(script);
    expect(script).toContain(`performTask("${SHOW_SCENE_TASK_NAME}", 10,`);
    expect(script).toContain(JSON.stringify(SCENE_JS_DIR_PLACEHOLDER));
    expect(script).toContain(`__waited < ${MENU_TIMEOUT_MS}`);
    expect(script).toContain("eval(__source);");
    // Re-performing TE Dispatch from inside it would be dropped.
    expect(script).not.toContain(`performTask("${DISPATCH_TASK_NAME}"`);
  });

  it("the scene JSON parses and loads te-menu.html via the placeholder", () => {
    const scene = JSON.parse(file(MENU_SCENE_FILENAME).content);
    expect(scene.name).toBe(MENU_TASK_NAME);
    expect(scene.root.children[0].content).toBe(
      `${SCENE_JS_DIR_PLACEHOLDER}${MENU_HTML_FILENAME}`
    );
    expect(scene.root.children[0].jsBridgeEnabled).toBe(true);
    expect(file(MENU_SCENE_FILENAME).content).toBe(
      menuSceneJson(SCENE_JS_DIR_PLACEHOLDER)
    );
  });

  it("the dispatcher maps TE Menu to the menu script", () => {
    expect(compileDispatcherJs(makeProject())).toContain(
      `"${MENU_TASK_NAME}": "${MENU_SCRIPT_FILENAME}",`
    );
  });

  it("rejects a user task named TE Menu", () => {
    expect(() =>
      compileProjectFiles(
        new Project({
          name: "P",
          tasks: [new Task({ name: MENU_TASK_NAME, actions: [Action.flash("x")] })],
        }),
        { repo: TEST_REPO }
      )
    ).toThrow(/te-menu\.js/);
  });
});
