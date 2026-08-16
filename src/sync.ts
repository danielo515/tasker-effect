/**
 * @module sync
 * @description Barrel for the profile sync, preserving the pre-split public
 * names. The implementation lives in sync/:
 *
 * - `sync/contract.ts` — errors, schemas, options and the FileStore /
 *   ZipExtractor capability tags (platform-free)
 * - `sync/core.ts` — the ProfileSync program against @effect/platform's
 *   HttpClient (platform-free)
 * - `sync/node.ts` — desktop layers (@effect/platform-node)
 * - `sync/tasker.ts` — on-device layers (Tasker builtins; import this module
 *   directly from scripts that get bundled for the device)
 *
 * Importing this barrel pulls in @effect/platform-node; device bundles must
 * import from `sync/tasker.ts` (and `sync/core.ts`/`sync/contract.ts`)
 * instead.
 */

export {
  GitHubApiError,
  DownloadError,
  NothingToSyncError,
  StorageWriteError,
  ZipExtractError,
  type ArtifactInfo,
  type SyncOptions,
  type SyncResult,
  type FileStoreShape,
  type ZipExtractorShape,
  DEFAULT_TARGET_DIR,
} from "./sync/contract.js";

export { ProfileSync } from "./sync/core.js";

export {
  // Node-flavored service classes: contract tags + a Node `.Default` layer
  FileStore,
  ZipExtractor,
  FileStoreNodeLive,
  ZipExtractorNodeLive,
  SyncNodeLive,
  pullLatestProfiles,
} from "./sync/node.js";

export {
  TaskerFileStore,
  TaskerZipExtractor,
  SyncTaskerLive,
  // Pre-split name for the on-device layer
  SyncTaskerLive as TaskerProfileSyncLive,
} from "./sync/tasker.js";
