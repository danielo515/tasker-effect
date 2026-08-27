import { describe, expect, it } from "@effect/vitest";
import {
  Action,
  Trigger,
  Task,
  Profile,
  Project,
  fmt,
  secret,
} from "../src/profile.js";
import {
  CONFIG_LABEL_FILENAME,
  CONFIG_SCAN_FILENAME,
  CONFIG_TASK_NAME,
  DISPATCHER_FILENAME,
  DISPATCH_TASK_NAME,
  ROLLING_RELEASE_TAG,
  SCAFFOLD_VERSION,
  SECRETS_FILENAME,
  SYNC_PROFILE_NAME,
  SYNC_SCRIPT_FILENAME,
  SYNC_TASK_NAME,
  TASKER_PROJECT_XML_FILENAME,
  compileDispatcherJs,
  compileProjectFiles,
  configLabelFileJs,
  configScanFileJs,
  syncBootstrapJs,
  taskerProjectXml,
} from "../src/compiler.js";

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
      `tasker-effect: scaffolding v${SCAFFOLD_VERSION} required (installed: v" + installed + ") - re-import ${TASKER_PROJECT_XML_FILENAME} from the js dir`
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

  it("is a project export: Project element listing the profile and the three tasks", () => {
    expect(xml).toContain('<TaskerData sr="" dvi="1"');
    expect(xml).toContain('<Project sr="proj0" ve="2">');
    expect(xml).toContain("<pids>4</pids>");
    expect(xml).toContain("<tids>1,2,3</tids>");
    expect(xml.match(/<Task sr="task\d+">/g)).toHaveLength(3);
    expect(xml.match(/<Profile sr="prof\d+" ve="2">/g)).toHaveLength(1);
    for (const name of [DISPATCH_TASK_NAME, SYNC_TASK_NAME, CONFIG_TASK_NAME]) {
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

  it("the TE Sync and TE Config scan scriptlets get generous 600s timeouts", () => {
    expect(actionContaining("releases/download")).toContain(
      '<Int sr="arg3" val="600"/>'
    );
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

  it("the TE Sync bootstrap self-installs sync-profiles.js from the rolling release", () => {
    const bootstrap = syncBootstrapJs(TEST_REPO);
    expect(bootstrap).toContain(
      `https://github.com/acme/automations/releases/download/${ROLLING_RELEASE_TAG}/${SYNC_SCRIPT_FILENAME}`
    );
    expect(bootstrap).toContain("readFile(path)");
    expect(bootstrap).toContain("writeFile(path, source, false);");
    expect(bootstrap).toContain("eval(source);");
    expect(bootstrap).toContain(`performTask("${CONFIG_TASK_NAME}", 5);`);
    // Token support: Authorization header from the %TE_GH_TOKEN global.
    expect(bootstrap).toContain('global("TE_GH_TOKEN")');
    expect(bootstrap).toContain('"Bearer " + token');
    expectValidSnippetJs(bootstrap);
    // And the snippet is embedded (XML-escaped) in the project XML.
    expect(xml).toContain("releases/download/tasker-js-latest/sync-profiles.js");
  });

  it("the TE Sync bootstrap stamps the scaffolding version on every run", () => {
    const stamp = `setGlobal("TE_SCAFFOLD_VERSION", "${SCAFFOLD_VERSION}");`;
    expect(syncBootstrapJs(TEST_REPO)).toContain(stamp);
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
    // Still exactly the three sanctioned tasks.
    expect(xml.match(/<Task sr="task\d+">/g)).toHaveLength(3);
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

  it("is static scaffolding: identical across projects and free of user content", () => {
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
    expect(xmlA!.content).toBe(xmlB!.content);
    expect(xmlA!.kind).toBe("tasker-xml");
    // No per-task content: user task/profile names, compiled JS and secret
    // names must never leak into the XML — only the static scaffolding plus
    // the dispatcher pointer and repo slug.
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
    // Exactly the sanctioned scaffolding names appear as tasks.
    const taskNames = [...xmlA!.content.matchAll(/<nme>([^<]*)<\/nme>/g)].map(
      (match) => match[1]
    );
    expect(taskNames.sort()).toEqual(
      [DISPATCH_TASK_NAME, SYNC_TASK_NAME, CONFIG_TASK_NAME, SYNC_PROFILE_NAME].sort()
    );
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
