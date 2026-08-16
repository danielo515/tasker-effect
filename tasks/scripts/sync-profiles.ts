/**
 * On-device sync: pull the latest compiled JS from GitHub CI releases.
 *
 * Bundle with `bun run compile`, copy dist-tasker/sync-profiles.js to the
 * device once, and point a Tasker JavaScript action at it (Auto Exit
 * disabled). Every run refreshes /sdcard/Tasker/js with the newest release
 * assets, so the rest of your tasks update themselves.
 *
 * The repo can be overridden with the Tasker globals %SYNC_OWNER and
 * %SYNC_REPO.
 */

import { Effect } from "effect";
import { Tasker } from "../../src/tasker-api.js";
// Import from sync/tasker.js directly: the sync.js barrel pulls in
// @effect/platform-node, which must never reach the device bundle.
import { ProfileSync, SyncTaskerLive } from "../../src/sync/tasker.js";
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

  const sync = yield* ProfileSync;
  const result = yield* sync.pullLatestProfiles({ owner, repo });

  yield* tasker.flash(
    `tasker-effect: synced ${result.files.length} file(s) from ${result.version}`
  );
});

void runInTasker(program.pipe(Effect.provide(SyncTaskerLive)), {
  exitWhenDone: true,
});
