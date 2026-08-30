/**
 * On-device sync: pull the latest compiled JS from GitHub CI releases.
 *
 * Bundle with `bun run compile`, copy dist-tasker/sync-profiles.js to the
 * device once, and point a Tasker JavaScript action at it (Auto Exit
 * disabled). Every run refreshes /sdcard/Tasker/js with the newest release
 * assets, so the rest of your tasks update themselves.
 *
 * The repo can be overridden with the Tasker globals %SYNC_OWNER and
 * %SYNC_REPO, the target directory with %TE_JS_DIR, and a GitHub token
 * (needed for private repos or artifact downloads) with %TE_GH_TOKEN.
 */

import { Effect } from "effect";
import { Tasker } from "../../src/tasker-api.js";
import { ProfileSync, SyncTaskerLive } from "../../src/sync/tasker.js";
import { DEFAULT_TARGET_DIR } from "../../src/sync/contract.js";
import { runInTasker } from "../../src/runtime.js";

const globalOr = (name: string, fallback: string) =>
  Effect.gen(function* () {
    const tasker = yield* Tasker;
    const value = yield* tasker
      .global(name)
      .pipe(Effect.orElseSucceed(() => ""));
    return value === "" || value === undefined ? fallback : value;
  });

const program = Effect.gen(function* () {
  const tasker = yield* Tasker;
  const owner = yield* globalOr("SYNC_OWNER", "danielo515");
  const repo = yield* globalOr("SYNC_REPO", "tasker-effect");
  const dir = yield* globalOr("TE_JS_DIR", DEFAULT_TARGET_DIR);
  const token = yield* globalOr("TE_GH_TOKEN", "");

  const sync = yield* ProfileSync;
  const result = yield* sync.pullLatestProfiles({
    owner,
    repo,
    targetDir: dir.replace(/\/+$/, ""),
    ...(token !== "" ? { token } : {}),
  });

  yield* tasker.flash(
    `tasker-effect: synced ${result.files.length} file(s) from ${result.version}`
  );
});

void runInTasker(program.pipe(Effect.provide(SyncTaskerLive)), {
  exitWhenDone: true,
});
