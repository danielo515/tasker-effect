/**
 * Clipboard history: remember the last few things copied, with no expiry.
 *
 * - The "Clipboard History" profile fires on every clipboard change and
 *   pushes the new text to the front of a JSON array kept in the Tasker
 *   global %CLIPBOARD_HISTORY (private to Tasker, never written to /sdcard).
 *   Duplicates move to the front instead of repeating; only the newest
 *   {@link MAX_ENTRIES} entries are kept.
 * - The "Show Clipboard History" task opens a Scenes v2 dialog
 *   (tasks/web/clipboard-history.scene.json) whose WebView
 *   (tasks/web/clipboard-history.html) lists the entries; tapping one copies
 *   it back to the clipboard.
 *
 * Password managers: the profile has an inverted App context for Bitwarden
 * so copies made from it are never stored.
 */

import { Action, Trigger, Task, Profile } from "../src/index.js";

/** How many clipboard entries to keep */
export const MAX_ENTRIES = 4;

/** Tasker global holding the history as a JSON array of { text, at } */
export const HISTORY_GLOBAL = "CLIPBOARD_HISTORY";

/** Synced Scenes v2 layout that hosts the history WebView */
export const HISTORY_SCENE_FILE = "clipboard-history.scene.json";

// Plain ES5: this runs inside Tasker's JavaScript engine.
const recordClipJs = [
  `var MAX = ${MAX_ENTRIES};`,
  "// %cl_text is the Clipboard Changed event's own output; %CLIP is a fallback.",
  'var clip = local("cl_text");',
  'if (clip === undefined || clip === null || clip === "") clip = global("CLIP");',
  'if (clip !== undefined && clip !== null && String(clip).replace(/\\s/g, "") !== "") {',
  "  clip = String(clip);",
  "  var history = [];",
  "  try {",
  `    history = JSON.parse(global("${HISTORY_GLOBAL}") || "[]");`,
  "  } catch (err) {",
  "    history = [];",
  "  }",
  "  if (!(history instanceof Array)) history = [];",
  "  var next = [{ text: clip, at: Date.now() }];",
  "  for (var i = 0; i < history.length && next.length < MAX; i++) {",
  "    if (history[i] && history[i].text !== clip) next.push(history[i]);",
  "  }",
  `  setGlobal("${HISTORY_GLOBAL}", JSON.stringify(next));`,
  "}",
].join("\n");

/** Record every clipboard change into %CLIPBOARD_HISTORY */
export const clipboardHistory = new Profile({
  name: "Clipboard History",
  description:
    `Keeps the last ${MAX_ENTRIES} clipboard entries in %${HISTORY_GLOBAL} with no expiry. ` +
    "Add an App context for Bitwarden with Invert ticked so passwords are never stored.",
  triggers: [
    Trigger.event("Clipboard Changed"),
    Trigger.state("App", "Bitwarden — tick Invert"),
  ],
  enter: new Task({
    name: "Record Clipboard",
    actions: [Action.js(recordClipJs)],
  }),
});

/** Open the clipboard history dialog (bind it to a gesture or shortcut) */
export const showClipboardHistory = new Task({
  name: "Show Clipboard History",
  description: "Shows the clipboard history dialog; tap an entry to copy it again",
  actions: [Action.showScene(HISTORY_SCENE_FILE)],
});
