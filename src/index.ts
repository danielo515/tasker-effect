/**
 * @module tasker-effect
 * @description Write Tasker (Android automation) tasks in TypeScript with
 * Effect, compile them to plain JavaScript that Tasker executes directly.
 */

// =============================================================================
// Tasker API bindings
// =============================================================================

export {
  // Option types
  type AudioStream,
  type AudioSource,
  type AudioCodec,
  type AudioFormat,
  type ButtonName,
  type DpadDirection,
  type MediaAction,
  type SilentMode,
  type StayOnMode,
  type RebootType,
  type LocationSource,
  type IntentTarget,
  type SettingsScreen,
  type SceneDisplayAs,
  type ConversionType,
  type ImageFilterMode,
  type RotateDirection,
  type LanguageModel,
  type CameraId,
  type ElementTextPosition,
  type SceneOrientation,
  // Errors
  TaskerCallError,
  TaskerNotAvailableError,
  type TaskerApiError,
  MissingSecretError,
  // Secrets runtime helper
  type SecretRef,
  requireSecret,
  // Raw surface
  type TaskerRawApi,
  TASKER_FUNCTION_NAMES,
  raw,
  // Service
  type TaskerApi,
  type TaskerShape,
  Tasker,
  // Test helpers
  type RecordedCall,
  makeTestTasker,
  makeTaskerTestLayer,
  TaskerTest,
} from "./tasker-api.js";

// =============================================================================
// Profile DSL
// =============================================================================

export {
  // Base schemas
  TimeOfDay,
  DayOfWeek,
  VolumeStream,
  ConditionOp,
  Condition,
  isGlobalVariable,
  variableName,
  // Secrets, variable references and interpolation
  Secret,
  secret,
  VariableRef,
  v,
  Interpolated,
  TextPart,
  type FmtValue,
  fmt,
  Text,
  NonEmptyText,
  VarName,
  varNameOf,
  // Action classes
  Flash,
  Popup,
  Say,
  Vibrate,
  VibratePattern,
  SetGlobal,
  SetLocal,
  PerformTask,
  PerformTaskerTask,
  EnableProfile,
  Wait,
  Shell,
  ReadFile,
  WriteFile,
  HttpRequest,
  BrowseUrl,
  SendSms,
  SetWifi,
  SetBluetooth,
  SetAirplaneMode,
  SetMobileData,
  SetAutoSync,
  SetVolume,
  MediaControl,
  MusicPlay,
  MusicStop,
  SetClip,
  SetWallpaper,
  LaunchApp,
  SendIntent,
  SetSilentMode,
  GoHome,
  GetLocation,
  JavaScript,
  If,
  type ActionEncoded,
  ActionSchema,
  // Trigger classes
  TimeTrigger,
  LocationTrigger,
  WifiConnectedTrigger,
  BluetoothConnectedTrigger,
  AppOpenedTrigger,
  BatteryLevelTrigger,
  VariableTrigger,
  EventTrigger,
  StateTrigger,
  TriggerSchema,
  // Core containers
  Task,
  Profile,
  Project,
  decodeTask,
  decodeProfile,
  decodeProject,
  // Builders (Action and Trigger double as builder namespaces)
  Action,
  Trigger,
  cond,
} from "./profile.js";

// =============================================================================
// Compiler (TS definitions → Tasker-executable JS)
// =============================================================================

export {
  CompileError,
  type CompiledFile,
  type RepoRef,
  type CompileProjectOptions,
  slugify,
  conditionExpr,
  emitAction,
  emitText,
  compileTaskToJs,
  describeTrigger,
  compileProfileFiles,
  compileProjectFiles,
  compileDispatcherJs,
  collectProjectSecrets,
  compileSecretsJson,
  taskerProjectXml,
  DEFAULT_DEVICE_JS_DIR,
  DISPATCHER_FILENAME,
  SECRETS_FILENAME,
  TASKER_PROJECT_XML_FILENAME,
  DISPATCH_TASK_NAME,
  SYNC_TASK_NAME,
  CONFIG_TASK_NAME,
  SYNC_PROFILE_NAME,
  TaskerCompiler,
} from "./compiler.js";

// =============================================================================
// Runtime helpers (for Effect-based scripts bundled for Tasker)
// =============================================================================

export { runInTasker } from "./runtime.js";

// =============================================================================
// Sync (pull compiled JS from CI) — platform-free surface only
// =============================================================================
//
// The platform layers live behind dedicated entry points so the bundler
// never sees the other platform's graph:
//   tasker-effect/sync/node    (desktop: @effect/platform-node)
//   tasker-effect/sync/tasker  (on-device: Tasker builtins)

export {
  GitHubApiError,
  DownloadError,
  NothingToSyncError,
  StorageWriteError,
  ZipExtractError,
  type ArtifactInfo,
  type FileStoreShape,
  type ZipExtractorShape,
  DEFAULT_TARGET_DIR,
  DEFAULT_ASSET_SUFFIXES,
  FileStore,
  ZipExtractor,
  type SyncOptions,
  type SyncResult,
} from "./sync/contract.js";

export { ProfileSync } from "./sync/core.js";
