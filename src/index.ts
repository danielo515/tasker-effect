/**
 * @module tasker-effect
 * @description TypeScript library for managing Tasker profiles using Effect
 */

// =============================================================================
// Tasker API Bindings
// =============================================================================

export {
  // Types
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
  type IntentCategory,
  type SettingsScreen,
  type SceneDisplayAs,
  type ConversionType,
  type ImageFilterMode,
  type LanguageModel,
  type CameraOption,
  type ElementTextPosition,
  // Errors
  TaskerError,
  TaskerNotAvailableError,
  // Service
  type TaskerService,
  Tasker,
  // Layers
  TaskerLive,
  TaskerMock,
} from "./tasker-api.js";

// =============================================================================
// Profile DSL
// =============================================================================

export {
  // Base types
  TimeSpec,
  type DayOfWeek,
  type Month,
  // Triggers
  type TimeTrigger,
  type LocationTrigger,
  type WifiTrigger,
  type BluetoothTrigger,
  type AppTrigger,
  type EventTrigger,
  type NotificationTrigger,
  type StateTrigger,
  type BatteryStateTrigger,
  type VariableTrigger,
  type EventType,
  type StateType,
  type Trigger,
  // Actions
  type FlashAction,
  type PopupAction,
  type SayAction,
  type VibrateAction,
  type SetVariableAction,
  type ClearVariableAction,
  type PerformTaskAction,
  type WaitAction,
  type StopAction,
  type IfAction,
  type ElseAction,
  type EndIfAction,
  type HttpRequestAction,
  type ShellAction,
  type JavaScriptletAction,
  type JavaScriptAction,
  type ShowSceneAction,
  type HideSceneAction,
  type SetWifiAction,
  type SetBluetoothAction,
  type SetVolumeAction,
  type BrowseUrlAction,
  type SendSmsAction,
  type WriteFileAction,
  type ReadFileAction,
  type LaunchAppAction,
  type ProfileStatusAction,
  type NotifyAction,
  type Action,
  // Core types
  type CollisionHandling,
  type Task,
  type Profile,
  type Project,
  // Helper builders
  time,
  location,
  wifi,
  bluetooth,
  app,
  battery,
  variable,
  flash,
  setVar,
  wait,
  performTask,
  shell,
  javascriptlet,
  http,
  task,
  profile,
  project,
} from "./profile.js";

// =============================================================================
// Compiler
// =============================================================================

export {
  CompilerError,
  type CompiledOutput,
  type TaskerCompilerService,
  TaskerCompiler,
  TaskerCompilerLive,
  compileTaskToXml,
  compileProfileToXml,
  compileProjectToXml,
} from "./compiler.js";

// =============================================================================
// Sync
// =============================================================================

export {
  type SyncConfig,
  SyncError,
  NetworkError,
  FileSystemError,
  type Artifact,
  type SyncResult,
  type HttpClientService,
  HttpClient,
  NodeHttpClient,
  type FileSystemService,
  FileSystem,
  NodeFileSystem,
  type SyncServiceInterface,
  SyncService,
  makeSyncService,
  NodeSyncLive,
  pullLatestProfiles,
} from "./sync.js";
