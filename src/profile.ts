/**
 * @module profile
 * @description Effect Schema DSL for defining Tasker tasks and profiles.
 *
 * Tasks are sequences of declarative actions. Each action maps to one or more
 * Tasker JavaScript API calls and is compiled to plain JavaScript by the
 * compiler module. Profiles bundle a task with the trigger metadata that
 * describes when Tasker should run it (the trigger itself is configured once
 * in the Tasker UI, pointing at the compiled JS file).
 */

import { Schema } from "effect";

// =============================================================================
// Base schemas
// =============================================================================

/** A time of day in 24h format */
export class TimeOfDay extends Schema.Class<TimeOfDay>("TimeOfDay")({
  hour: Schema.Number.pipe(Schema.int(), Schema.between(0, 23)),
  minute: Schema.Number.pipe(Schema.int(), Schema.between(0, 59)),
}) {}

export const DayOfWeek = Schema.Literal(
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday"
);
export type DayOfWeek = typeof DayOfWeek.Type;

/** Volume streams settable via the JS API */
export const VolumeStream = Schema.Literal(
  "alarm",
  "system",
  "media",
  "ringer",
  "notification",
  "call",
  "dtmf",
  "btvoice"
);
export type VolumeStream = typeof VolumeStream.Type;

/** Comparison operators available in conditions */
export const ConditionOp = Schema.Literal(
  "eq",
  "neq",
  "lt",
  "gt",
  "lte",
  "gte",
  "contains",
  "matches",
  "isSet",
  "notSet"
);
export type ConditionOp = typeof ConditionOp.Type;

/**
 * A condition over a Tasker variable. Variable names follow Tasker
 * conventions: ALL-CAPS names are globals, lowercase names are locals.
 * The leading % is optional.
 */
export class Condition extends Schema.Class<Condition>("Condition")({
  variable: Schema.NonEmptyString,
  op: ConditionOp,
  value: Schema.optional(Schema.String),
}) {}

const percentLess = (name: string): string =>
  name.startsWith("%") ? name.slice(1) : name;

/** Whether a Tasker variable name refers to a global (ALL-CAPS) variable */
export const isGlobalVariable = (name: string): boolean => {
  const bare = percentLess(name);
  return bare === bare.toUpperCase();
};

/** Normalize a variable name by stripping the leading % */
export const variableName = percentLess;

// =============================================================================
// Actions
// =============================================================================

/** Show a toast message */
export class Flash extends Schema.TaggedClass<Flash>()("Flash", {
  text: Schema.NonEmptyString,
  long: Schema.optionalWith(Schema.Boolean, { default: () => false }),
}) {}

/** Show a popup dialog */
export class Popup extends Schema.TaggedClass<Popup>()("Popup", {
  title: Schema.String,
  text: Schema.String,
  showOverKeyguard: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  timeoutSecs: Schema.optionalWith(Schema.Number.pipe(Schema.nonNegative()), {
    default: () => 0,
  }),
}) {}

/** Speak text via TTS */
export class Say extends Schema.TaggedClass<Say>()("Say", {
  text: Schema.NonEmptyString,
  engine: Schema.optional(Schema.String),
  voice: Schema.optional(Schema.String),
  stream: Schema.optionalWith(
    Schema.Literal("call", "system", "ringer", "media", "alarm", "notification"),
    { default: () => "media" as const }
  ),
  pitch: Schema.optionalWith(Schema.Number.pipe(Schema.between(1, 10)), {
    default: () => 5,
  }),
  speed: Schema.optionalWith(Schema.Number.pipe(Schema.between(1, 10)), {
    default: () => 5,
  }),
}) {}

/** Vibrate for a duration in milliseconds */
export class Vibrate extends Schema.TaggedClass<Vibrate>()("Vibrate", {
  milliseconds: Schema.Number.pipe(Schema.positive()),
}) {}

/** Vibrate with an off,on,off,on... millisecond pattern */
export class VibratePattern extends Schema.TaggedClass<VibratePattern>()(
  "VibratePattern",
  {
    pattern: Schema.NonEmptyString.pipe(Schema.pattern(/^\d+(,\d+)*$/)),
  }
) {}

/** Set a Tasker global variable */
export class SetGlobal extends Schema.TaggedClass<SetGlobal>()("SetGlobal", {
  name: Schema.NonEmptyString,
  value: Schema.String,
}) {}

/** Set a scene-local variable */
export class SetLocal extends Schema.TaggedClass<SetLocal>()("SetLocal", {
  name: Schema.NonEmptyString,
  value: Schema.String,
}) {}

/**
 * Run another DSL-defined task, routed through the shared dispatcher task
 * (`TE Dispatch`). Stores only the target task's *name* — actions stay flat
 * and serializable; use the `Action.performTask(task)` builder to derive it
 * from a `Task` object.
 *
 * No custom parameters: the dispatcher consumes `%par1` as the target name
 * and `%par2` as its exit switch, so there is nothing left to forward. Use
 * `PerformTaskerTask` for a direct call that supports parameters.
 */
export class PerformTask extends Schema.TaggedClass<PerformTask>()(
  "PerformTask",
  {
    taskName: Schema.NonEmptyString,
    priority: Schema.optionalWith(
      Schema.Number.pipe(Schema.int(), Schema.between(1, 50)),
      { default: () => 5 }
    ),
  }
) {}

/**
 * Run a task created by hand in the Tasker UI, by name — a direct
 * `performTask(...)` call, exactly like Tasker's own action. No validation
 * beyond the name being non-empty: the referenced task only exists on the
 * phone, so the compiler cannot check it.
 */
export class PerformTaskerTask extends Schema.TaggedClass<PerformTaskerTask>()(
  "PerformTaskerTask",
  {
    taskName: Schema.NonEmptyString,
    priority: Schema.optionalWith(
      Schema.Number.pipe(Schema.int(), Schema.between(1, 50)),
      { default: () => 5 }
    ),
    parameterOne: Schema.optional(Schema.String),
    parameterTwo: Schema.optional(Schema.String),
  }
) {}

/** Enable or disable a Tasker profile */
export class EnableProfile extends Schema.TaggedClass<EnableProfile>()(
  "EnableProfile",
  {
    profileName: Schema.NonEmptyString,
    enable: Schema.Boolean,
  }
) {}

/** Pause execution */
export class Wait extends Schema.TaggedClass<Wait>()("Wait", {
  milliseconds: Schema.Number.pipe(Schema.positive()),
}) {}

/** Run a shell command, optionally storing its output in a global variable */
export class Shell extends Schema.TaggedClass<Shell>()("Shell", {
  command: Schema.NonEmptyString,
  asRoot: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  timeoutSecs: Schema.optionalWith(Schema.Number.pipe(Schema.positive()), {
    default: () => 30,
  }),
  outputGlobal: Schema.optional(Schema.String),
}) {}

/** Read a file into a global variable */
export class ReadFile extends Schema.TaggedClass<ReadFile>()("ReadFile", {
  path: Schema.NonEmptyString,
  outputGlobal: Schema.NonEmptyString,
}) {}

/** Write text to a file */
export class WriteFile extends Schema.TaggedClass<WriteFile>()("WriteFile", {
  path: Schema.NonEmptyString,
  text: Schema.String,
  append: Schema.optionalWith(Schema.Boolean, { default: () => false }),
}) {}

/**
 * Perform an HTTP request with a synchronous XMLHttpRequest (works in
 * Tasker's WebView environment), optionally storing the response body in a
 * global variable.
 */
export class HttpRequest extends Schema.TaggedClass<HttpRequest>()(
  "HttpRequest",
  {
    method: Schema.Literal("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"),
    url: Schema.NonEmptyString,
    headers: Schema.optionalWith(
      Schema.Record({ key: Schema.String, value: Schema.String }),
      { default: () => ({}) }
    ),
    body: Schema.optional(Schema.String),
    outputGlobal: Schema.optional(Schema.String),
  }
) {}

/** Open a URL in the default browser */
export class BrowseUrl extends Schema.TaggedClass<BrowseUrl>()("BrowseUrl", {
  url: Schema.NonEmptyString,
}) {}

/** Send an SMS */
export class SendSms extends Schema.TaggedClass<SendSms>()("SendSms", {
  number: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
  storeInMessagingApp: Schema.optionalWith(Schema.Boolean, {
    default: () => false,
  }),
}) {}

/** Enable/disable Wi-Fi */
export class SetWifi extends Schema.TaggedClass<SetWifi>()("SetWifi", {
  on: Schema.Boolean,
}) {}

/** Enable/disable Bluetooth */
export class SetBluetooth extends Schema.TaggedClass<SetBluetooth>()(
  "SetBluetooth",
  {
    on: Schema.Boolean,
  }
) {}

/** Enable/disable airplane mode */
export class SetAirplaneMode extends Schema.TaggedClass<SetAirplaneMode>()(
  "SetAirplaneMode",
  {
    on: Schema.Boolean,
  }
) {}

/** Enable/disable the mobile data setting */
export class SetMobileData extends Schema.TaggedClass<SetMobileData>()(
  "SetMobileData",
  {
    on: Schema.Boolean,
  }
) {}

/** Enable/disable global auto-sync */
export class SetAutoSync extends Schema.TaggedClass<SetAutoSync>()(
  "SetAutoSync",
  {
    on: Schema.Boolean,
  }
) {}

/** Set the volume of an audio stream */
export class SetVolume extends Schema.TaggedClass<SetVolume>()("SetVolume", {
  stream: VolumeStream,
  level: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  display: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  sound: Schema.optionalWith(Schema.Boolean, { default: () => false }),
}) {}

/** Send a media control action to the foreground media app */
export class MediaControl extends Schema.TaggedClass<MediaControl>()(
  "MediaControl",
  {
    action: Schema.Literal("next", "pause", "prev", "toggle", "stop", "play"),
  }
) {}

/** Play a music file */
export class MusicPlay extends Schema.TaggedClass<MusicPlay>()("MusicPlay", {
  path: Schema.NonEmptyString,
  offsetSecs: Schema.optionalWith(Schema.Number.pipe(Schema.nonNegative()), {
    default: () => 0,
  }),
  loop: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  stream: Schema.optionalWith(
    Schema.Literal("call", "system", "ringer", "media", "alarm", "notification"),
    { default: () => "media" as const }
  ),
}) {}

/** Stop music playback */
export class MusicStop extends Schema.TaggedClass<MusicStop>()("MusicStop", {}) {}

/** Set the clipboard */
export class SetClip extends Schema.TaggedClass<SetClip>()("SetClip", {
  text: Schema.String,
  append: Schema.optionalWith(Schema.Boolean, { default: () => false }),
}) {}

/** Set the home screen wallpaper */
export class SetWallpaper extends Schema.TaggedClass<SetWallpaper>()(
  "SetWallpaper",
  {
    path: Schema.NonEmptyString,
  }
) {}

/** Launch an app by package name or label */
export class LaunchApp extends Schema.TaggedClass<LaunchApp>()("LaunchApp", {
  app: Schema.NonEmptyString,
  data: Schema.optional(Schema.String),
  excludeFromRecents: Schema.optionalWith(Schema.Boolean, {
    default: () => false,
  }),
}) {}

/** Send an Android intent */
export class SendIntent extends Schema.TaggedClass<SendIntent>()("SendIntent", {
  action: Schema.NonEmptyString,
  targetComp: Schema.Literal("receiver", "activity", "service"),
  pkg: Schema.optional(Schema.String),
  cls: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  data: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  extras: Schema.optionalWith(Schema.Array(Schema.String), {
    default: () => [],
  }),
}) {}

/** Set the ringer mode */
export class SetSilentMode extends Schema.TaggedClass<SetSilentMode>()(
  "SetSilentMode",
  {
    mode: Schema.Literal("off", "vibrate", "on"),
  }
) {}

/** Go to the home screen */
export class GoHome extends Schema.TaggedClass<GoHome>()("GoHome", {
  screen: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.nonNegative()), {
    default: () => 0,
  }),
}) {}

/** Request a location fix (%LOC / %LOCN get populated) */
export class GetLocation extends Schema.TaggedClass<GetLocation>()(
  "GetLocation",
  {
    source: Schema.Literal("gps", "net", "any"),
    keepTracking: Schema.optionalWith(Schema.Boolean, { default: () => false }),
    timeoutSecs: Schema.optionalWith(Schema.Number.pipe(Schema.positive()), {
      default: () => 100,
    }),
  }
) {}

/** Enable/disable Android car mode */
export class SetCarMode extends Schema.TaggedClass<SetCarMode>()("SetCarMode", {
  on: Schema.Boolean,
}) {}

/** Enable/disable Android night mode */
export class SetNightMode extends Schema.TaggedClass<SetNightMode>()(
  "SetNightMode",
  {
    on: Schema.Boolean,
  }
) {}

/** Keep the display on while powered from the given source */
export class SetStayOn extends Schema.TaggedClass<SetStayOn>()("SetStayOn", {
  mode: Schema.Literal("never", "ac", "usb", "any"),
}) {}

/** Enable/disable display auto-rotation */
export class SetAutoRotate extends Schema.TaggedClass<SetAutoRotate>()(
  "SetAutoRotate",
  {
    on: Schema.Boolean,
  }
) {}

/** Enable/disable automatic brightness */
export class SetAutoBrightness extends Schema.TaggedClass<SetAutoBrightness>()(
  "SetAutoBrightness",
  {
    on: Schema.Boolean,
  }
) {}

/** Set the display auto-off timeout */
export class SetDisplayTimeout extends Schema.TaggedClass<SetDisplayTimeout>()(
  "SetDisplayTimeout",
  {
    hours: Schema.optionalWith(
      Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      { default: () => 0 }
    ),
    minutes: Schema.optionalWith(
      Schema.Number.pipe(Schema.int(), Schema.between(0, 59)),
      { default: () => 0 }
    ),
    seconds: Schema.optionalWith(
      Schema.Number.pipe(Schema.int(), Schema.between(0, 59)),
      { default: () => 0 }
    ),
  }
) {}

/** Raw JavaScript escape hatch, inserted verbatim into the compiled output */
export class JavaScript extends Schema.TaggedClass<JavaScript>()("JavaScript", {
  code: Schema.NonEmptyString,
}) {}

/** Conditional block over a Tasker variable */
export class If extends Schema.TaggedClass<If>()("If", {
  condition: Condition,
  then: Schema.Array(
    Schema.suspend((): Schema.Schema<Action, ActionEncoded> => ActionSchema)
  ),
  orElse: Schema.optionalWith(
    Schema.Array(
      Schema.suspend((): Schema.Schema<Action, ActionEncoded> => ActionSchema)
    ),
    { default: () => [] }
  ),
}) {}

/** Union of every action */
export type Action =
  | Flash
  | Popup
  | Say
  | Vibrate
  | VibratePattern
  | SetGlobal
  | SetLocal
  | PerformTask
  | PerformTaskerTask
  | EnableProfile
  | Wait
  | Shell
  | ReadFile
  | WriteFile
  | HttpRequest
  | BrowseUrl
  | SendSms
  | SetWifi
  | SetBluetooth
  | SetAirplaneMode
  | SetMobileData
  | SetAutoSync
  | SetVolume
  | MediaControl
  | MusicPlay
  | MusicStop
  | SetClip
  | SetWallpaper
  | LaunchApp
  | SendIntent
  | SetSilentMode
  | GoHome
  | GetLocation
  | SetCarMode
  | SetNightMode
  | SetStayOn
  | SetAutoRotate
  | SetAutoBrightness
  | SetDisplayTimeout
  | JavaScript
  | If;

/** Encoded (wire) form of an action */
export type ActionEncoded = { readonly _tag: string } & Record<string, unknown>;

const actionMembers = [
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
  SetCarMode,
  SetNightMode,
  SetStayOn,
  SetAutoRotate,
  SetAutoBrightness,
  SetDisplayTimeout,
  JavaScript,
  If,
] as const;

/** Schema accepting any action */
export const ActionSchema: Schema.Schema<Action, ActionEncoded> = Schema.Union(
  ...actionMembers
) as unknown as Schema.Schema<Action, ActionEncoded>;

// =============================================================================
// Triggers (metadata describing when Tasker should run the compiled JS)
// =============================================================================

/** Active during a time window, optionally on given days */
export class TimeTrigger extends Schema.TaggedClass<TimeTrigger>()(
  "TimeTrigger",
  {
    from: TimeOfDay,
    to: Schema.optional(TimeOfDay),
    repeatMinutes: Schema.optional(Schema.Number.pipe(Schema.positive())),
    days: Schema.optionalWith(Schema.Array(DayOfWeek), { default: () => [] }),
  }
) {}

/** Active inside a geographic radius */
export class LocationTrigger extends Schema.TaggedClass<LocationTrigger>()(
  "LocationTrigger",
  {
    latitude: Schema.Number.pipe(Schema.between(-90, 90)),
    longitude: Schema.Number.pipe(Schema.between(-180, 180)),
    radiusMeters: Schema.Number.pipe(Schema.positive()),
  }
) {}

/** Active while connected to a Wi-Fi network */
export class WifiConnectedTrigger extends Schema.TaggedClass<WifiConnectedTrigger>()(
  "WifiConnectedTrigger",
  {
    ssid: Schema.optionalWith(Schema.String, { default: () => "*" }),
  }
) {}

/** Active while connected to a Bluetooth device */
export class BluetoothConnectedTrigger extends Schema.TaggedClass<BluetoothConnectedTrigger>()(
  "BluetoothConnectedTrigger",
  {
    name: Schema.optionalWith(Schema.String, { default: () => "*" }),
  }
) {}

/** Active while an app is in the foreground */
export class AppOpenedTrigger extends Schema.TaggedClass<AppOpenedTrigger>()(
  "AppOpenedTrigger",
  {
    app: Schema.NonEmptyString,
  }
) {}

/** Active while the battery level is inside a range */
export class BatteryLevelTrigger extends Schema.TaggedClass<BatteryLevelTrigger>()(
  "BatteryLevelTrigger",
  {
    from: Schema.Number.pipe(Schema.int(), Schema.between(0, 100)),
    to: Schema.Number.pipe(Schema.int(), Schema.between(0, 100)),
  }
) {}

/** Active while a wired or Bluetooth headset is plugged in */
export class HeadsetPluggedTrigger extends Schema.TaggedClass<HeadsetPluggedTrigger>()(
  "HeadsetPluggedTrigger",
  {
    kind: Schema.optionalWith(Schema.Literal("any", "mic", "no-mic"), {
      default: () => "any" as const,
    }),
  }
) {}

/** Active while the device is on external power */
export class PowerTrigger extends Schema.TaggedClass<PowerTrigger>()(
  "PowerTrigger",
  {
    source: Schema.optionalWith(
      Schema.Literal("any", "ac", "usb", "wireless"),
      { default: () => "any" as const }
    ),
  }
) {}

/** Active during a calendar entry, optionally filtered by calendar/title */
export class CalendarEntryTrigger extends Schema.TaggedClass<CalendarEntryTrigger>()(
  "CalendarEntryTrigger",
  {
    calendar: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
  }
) {}

/** Fires when a text message arrives, optionally filtered by sender */
export class ReceivedTextTrigger extends Schema.TaggedClass<ReceivedTextTrigger>()(
  "ReceivedTextTrigger",
  {
    kind: Schema.optionalWith(Schema.Literal("any", "sms", "mms"), {
      default: () => "any" as const,
    }),
    sender: Schema.optional(Schema.String),
  }
) {}

/** Active while a Tasker variable satisfies a condition */
export class VariableTrigger extends Schema.TaggedClass<VariableTrigger>()(
  "VariableTrigger",
  {
    condition: Condition,
  }
) {}

/** Fires on a named Tasker event (e.g. "Display On", "Notification") */
export class EventTrigger extends Schema.TaggedClass<EventTrigger>()(
  "EventTrigger",
  {
    event: Schema.NonEmptyString,
    parameter: Schema.optional(Schema.String),
  }
) {}

/** Active while a named Tasker state holds (e.g. "Power", "Headset Plugged") */
export class StateTrigger extends Schema.TaggedClass<StateTrigger>()(
  "StateTrigger",
  {
    state: Schema.NonEmptyString,
    parameter: Schema.optional(Schema.String),
  }
) {}

/** Union of every trigger */
export type Trigger =
  | TimeTrigger
  | LocationTrigger
  | WifiConnectedTrigger
  | BluetoothConnectedTrigger
  | AppOpenedTrigger
  | BatteryLevelTrigger
  | HeadsetPluggedTrigger
  | PowerTrigger
  | CalendarEntryTrigger
  | ReceivedTextTrigger
  | VariableTrigger
  | EventTrigger
  | StateTrigger;

/** Schema accepting any trigger */
export const TriggerSchema = Schema.Union(
  TimeTrigger,
  LocationTrigger,
  WifiConnectedTrigger,
  BluetoothConnectedTrigger,
  AppOpenedTrigger,
  BatteryLevelTrigger,
  HeadsetPluggedTrigger,
  PowerTrigger,
  CalendarEntryTrigger,
  ReceivedTextTrigger,
  VariableTrigger,
  EventTrigger,
  StateTrigger
);

// =============================================================================
// Task / Profile / Project
// =============================================================================

/** A named sequence of actions, compiled to one JavaScript file */
export class Task extends Schema.Class<Task>("Task")({
  name: Schema.NonEmptyString,
  actions: Schema.NonEmptyArray(ActionSchema),
  description: Schema.optional(Schema.String),
}) {}

/**
 * A profile pairs trigger metadata with an enter (and optional exit) task.
 * Triggers are configured once in the Tasker UI; the compiler emits setup
 * instructions for them alongside the JavaScript files.
 */
export class Profile extends Schema.Class<Profile>("Profile")({
  name: Schema.NonEmptyString,
  triggers: Schema.NonEmptyArray(TriggerSchema),
  enter: Task,
  exit: Schema.optional(Task),
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  description: Schema.optional(Schema.String),
}) {}

/** A collection of profiles and standalone tasks */
export class Project extends Schema.Class<Project>("Project")({
  name: Schema.NonEmptyString,
  profiles: Schema.optionalWith(Schema.Array(Profile), { default: () => [] }),
  tasks: Schema.optionalWith(Schema.Array(Task), { default: () => [] }),
  description: Schema.optional(Schema.String),
}) {}

/** Decode an unknown value into a Task */
export const decodeTask = Schema.decodeUnknown(Task);

/** Decode an unknown value into a Profile */
export const decodeProfile = Schema.decodeUnknown(Profile);

/** Decode an unknown value into a Project */
export const decodeProject = Schema.decodeUnknown(Project);

// =============================================================================
// Builders
// =============================================================================

/** Ergonomic factories for every action */
export const Action = {
  flash: (text: string, options?: { readonly long?: boolean }) =>
    new Flash({ text, long: options?.long ?? false }),
  popup: (
    title: string,
    text: string,
    options?: { readonly showOverKeyguard?: boolean; readonly timeoutSecs?: number }
  ) =>
    new Popup({
      title,
      text,
      showOverKeyguard: options?.showOverKeyguard ?? false,
      timeoutSecs: options?.timeoutSecs ?? 0,
    }),
  say: (
    text: string,
    options?: {
      readonly engine?: string;
      readonly voice?: string;
      readonly stream?: Say["stream"];
      readonly pitch?: number;
      readonly speed?: number;
    }
  ) =>
    new Say({
      text,
      stream: options?.stream ?? "media",
      pitch: options?.pitch ?? 5,
      speed: options?.speed ?? 5,
      ...(options?.engine !== undefined ? { engine: options.engine } : {}),
      ...(options?.voice !== undefined ? { voice: options.voice } : {}),
    }),
  vibrate: (milliseconds: number) => new Vibrate({ milliseconds }),
  vibratePattern: (pattern: string) => new VibratePattern({ pattern }),
  setGlobal: (name: string, value: string) =>
    new SetGlobal({ name: variableName(name), value }),
  setLocal: (name: string, value: string) =>
    new SetLocal({ name: variableName(name), value }),
  /**
   * Call another DSL task by reference. Routed through the dispatcher, which
   * uses `%par1`/`%par2` for its own resolution — custom parameters are not
   * supported here; use {@link Action.performTaskerTask} for that.
   */
  performTask: (task: Task, options?: { readonly priority?: number }) =>
    new PerformTask({
      taskName: task.name,
      priority: options?.priority ?? 5,
    }),
  /** Call a task that only exists in the Tasker UI, by name (direct call) */
  performTaskerTask: (
    taskName: string,
    options?: {
      readonly priority?: number;
      readonly parameterOne?: string;
      readonly parameterTwo?: string;
    }
  ) =>
    new PerformTaskerTask({
      taskName,
      priority: options?.priority ?? 5,
      ...(options?.parameterOne !== undefined
        ? { parameterOne: options.parameterOne }
        : {}),
      ...(options?.parameterTwo !== undefined
        ? { parameterTwo: options.parameterTwo }
        : {}),
    }),
  /** Enable/disable a DSL profile by reference */
  enableProfile: (profile: Profile, enable = true) =>
    new EnableProfile({ profileName: profile.name, enable }),
  /** Enable/disable a profile that only exists in the Tasker UI, by name */
  enableTaskerProfile: (profileName: string, enable = true) =>
    new EnableProfile({ profileName, enable }),
  wait: (milliseconds: number) => new Wait({ milliseconds }),
  shell: (
    command: string,
    options?: {
      readonly asRoot?: boolean;
      readonly timeoutSecs?: number;
      readonly outputGlobal?: string;
    }
  ) =>
    new Shell({
      command,
      asRoot: options?.asRoot ?? false,
      timeoutSecs: options?.timeoutSecs ?? 30,
      ...(options?.outputGlobal !== undefined
        ? { outputGlobal: variableName(options.outputGlobal) }
        : {}),
    }),
  readFile: (path: string, outputGlobal: string) =>
    new ReadFile({ path, outputGlobal: variableName(outputGlobal) }),
  writeFile: (path: string, text: string, options?: { readonly append?: boolean }) =>
    new WriteFile({ path, text, append: options?.append ?? false }),
  http: (
    method: HttpRequest["method"],
    url: string,
    options?: {
      readonly headers?: Record<string, string>;
      readonly body?: string;
      readonly outputGlobal?: string;
    }
  ) =>
    new HttpRequest({
      method,
      url,
      headers: options?.headers ?? {},
      ...(options?.body !== undefined ? { body: options.body } : {}),
      ...(options?.outputGlobal !== undefined
        ? { outputGlobal: variableName(options.outputGlobal) }
        : {}),
    }),
  browseUrl: (url: string) => new BrowseUrl({ url }),
  sendSms: (number: string, text: string, options?: { readonly store?: boolean }) =>
    new SendSms({
      number,
      text,
      storeInMessagingApp: options?.store ?? false,
    }),
  setWifi: (on: boolean) => new SetWifi({ on }),
  setBluetooth: (on: boolean) => new SetBluetooth({ on }),
  setAirplaneMode: (on: boolean) => new SetAirplaneMode({ on }),
  setMobileData: (on: boolean) => new SetMobileData({ on }),
  setAutoSync: (on: boolean) => new SetAutoSync({ on }),
  setVolume: (
    stream: VolumeStream,
    level: number,
    options?: { readonly display?: boolean; readonly sound?: boolean }
  ) =>
    new SetVolume({
      stream,
      level,
      display: options?.display ?? false,
      sound: options?.sound ?? false,
    }),
  mediaControl: (action: MediaControl["action"]) => new MediaControl({ action }),
  musicPlay: (
    path: string,
    options?: {
      readonly offsetSecs?: number;
      readonly loop?: boolean;
      readonly stream?: MusicPlay["stream"];
    }
  ) =>
    new MusicPlay({
      path,
      offsetSecs: options?.offsetSecs ?? 0,
      loop: options?.loop ?? false,
      stream: options?.stream ?? "media",
    }),
  musicStop: () => new MusicStop({}),
  setClip: (text: string, options?: { readonly append?: boolean }) =>
    new SetClip({ text, append: options?.append ?? false }),
  setWallpaper: (path: string) => new SetWallpaper({ path }),
  launchApp: (
    app: string,
    options?: { readonly data?: string; readonly excludeFromRecents?: boolean }
  ) =>
    new LaunchApp({
      app,
      excludeFromRecents: options?.excludeFromRecents ?? false,
      ...(options?.data !== undefined ? { data: options.data } : {}),
    }),
  sendIntent: (
    action: string,
    targetComp: SendIntent["targetComp"],
    options?: {
      readonly pkg?: string;
      readonly cls?: string;
      readonly category?: string;
      readonly data?: string;
      readonly mimeType?: string;
      readonly extras?: ReadonlyArray<string>;
    }
  ) =>
    new SendIntent({
      action,
      targetComp,
      extras: options?.extras ?? [],
      ...(options?.pkg !== undefined ? { pkg: options.pkg } : {}),
      ...(options?.cls !== undefined ? { cls: options.cls } : {}),
      ...(options?.category !== undefined ? { category: options.category } : {}),
      ...(options?.data !== undefined ? { data: options.data } : {}),
      ...(options?.mimeType !== undefined ? { mimeType: options.mimeType } : {}),
    }),
  silentMode: (mode: SetSilentMode["mode"]) => new SetSilentMode({ mode }),
  goHome: (screen = 0) => new GoHome({ screen }),
  getLocation: (
    source: GetLocation["source"],
    options?: { readonly keepTracking?: boolean; readonly timeoutSecs?: number }
  ) =>
    new GetLocation({
      source,
      keepTracking: options?.keepTracking ?? false,
      timeoutSecs: options?.timeoutSecs ?? 100,
    }),
  setCarMode: (on: boolean) => new SetCarMode({ on }),
  setNightMode: (on: boolean) => new SetNightMode({ on }),
  stayOn: (mode: SetStayOn["mode"]) => new SetStayOn({ mode }),
  setAutoRotate: (on: boolean) => new SetAutoRotate({ on }),
  setAutoBrightness: (on: boolean) => new SetAutoBrightness({ on }),
  displayTimeout: (timeout: {
    readonly hours?: number;
    readonly minutes?: number;
    readonly seconds?: number;
  }) =>
    new SetDisplayTimeout({
      hours: timeout.hours ?? 0,
      minutes: timeout.minutes ?? 0,
      seconds: timeout.seconds ?? 0,
    }),
  js: (code: string) => new JavaScript({ code }),
  when: (
    condition: Condition,
    then: ReadonlyArray<Action>,
    orElse: ReadonlyArray<Action> = []
  ) => new If({ condition, then, orElse }),
} as const;

/** Build a condition over a Tasker variable */
export const cond = (
  variable: string,
  op: ConditionOp,
  value?: string
): Condition =>
  new Condition({
    variable: variableName(variable),
    op,
    ...(value !== undefined ? { value } : {}),
  });

/** Ergonomic factories for every trigger */
export const Trigger = {
  time: (
    from: { readonly hour: number; readonly minute: number },
    options?: {
      readonly to?: { readonly hour: number; readonly minute: number };
      readonly repeatMinutes?: number;
      readonly days?: ReadonlyArray<DayOfWeek>;
    }
  ) =>
    new TimeTrigger({
      from: new TimeOfDay(from),
      days: options?.days ?? [],
      ...(options?.to !== undefined ? { to: new TimeOfDay(options.to) } : {}),
      ...(options?.repeatMinutes !== undefined
        ? { repeatMinutes: options.repeatMinutes }
        : {}),
    }),
  location: (latitude: number, longitude: number, radiusMeters: number) =>
    new LocationTrigger({ latitude, longitude, radiusMeters }),
  wifiConnected: (ssid = "*") => new WifiConnectedTrigger({ ssid }),
  bluetoothConnected: (name = "*") => new BluetoothConnectedTrigger({ name }),
  appOpened: (app: string) => new AppOpenedTrigger({ app }),
  batteryLevel: (from: number, to: number) => new BatteryLevelTrigger({ from, to }),
  headsetPlugged: (kind: HeadsetPluggedTrigger["kind"] = "any") =>
    new HeadsetPluggedTrigger({ kind }),
  power: (source: PowerTrigger["source"] = "any") =>
    new PowerTrigger({ source }),
  calendarEntry: (options?: {
    readonly calendar?: string;
    readonly title?: string;
  }) =>
    new CalendarEntryTrigger({
      ...(options?.calendar !== undefined ? { calendar: options.calendar } : {}),
      ...(options?.title !== undefined ? { title: options.title } : {}),
    }),
  receivedText: (options?: {
    readonly kind?: ReceivedTextTrigger["kind"];
    readonly sender?: string;
  }) =>
    new ReceivedTextTrigger({
      kind: options?.kind ?? "any",
      ...(options?.sender !== undefined ? { sender: options.sender } : {}),
    }),
  variable: (condition: Condition) => new VariableTrigger({ condition }),
  event: (event: string, parameter?: string) =>
    new EventTrigger({
      event,
      ...(parameter !== undefined ? { parameter } : {}),
    }),
  state: (state: string, parameter?: string) =>
    new StateTrigger({
      state,
      ...(parameter !== undefined ? { parameter } : {}),
    }),
} as const;
