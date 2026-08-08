/**
 * @module profile
 * @description Effect Schema-based DSL for defining Tasker profiles, tasks, and actions
 */

import { Schema } from "effect";

// =============================================================================
// Base Types
// =============================================================================

/** Time specification (24h format) */
export interface TimeSpec {
  readonly hour: number;
  readonly minute: number;
}

export const TimeSpec = Schema.Struct({
  hour: Schema.Number.pipe(Schema.int(), Schema.between(0, 23)),
  minute: Schema.Number.pipe(Schema.int(), Schema.between(0, 59)),
});

/** Day of week */
export type DayOfWeek =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/** Month */
export type Month =
  | "january"
  | "february"
  | "march"
  | "april"
  | "may"
  | "june"
  | "july"
  | "august"
  | "september"
  | "october"
  | "november"
  | "december";

// =============================================================================
// Trigger Types
// =============================================================================

/** Time-based trigger */
export interface TimeTrigger {
  readonly _tag: "TimeTrigger";
  readonly from: TimeSpec;
  readonly to?: TimeSpec;
  readonly repeatMinutes?: number;
  readonly days?: readonly DayOfWeek[];
  readonly months?: readonly Month[];
  readonly invert?: boolean;
}

/** Location trigger */
export interface LocationTrigger {
  readonly _tag: "LocationTrigger";
  readonly latitude: number;
  readonly longitude: number;
  readonly radius: number;
  readonly invert?: boolean;
}

/** WiFi trigger */
export interface WifiTrigger {
  readonly _tag: "WifiTrigger";
  readonly ssid?: string;
  readonly mac?: string;
  readonly connected?: boolean;
  readonly invert?: boolean;
}

/** Bluetooth trigger */
export interface BluetoothTrigger {
  readonly _tag: "BluetoothTrigger";
  readonly name?: string;
  readonly address?: string;
  readonly connected?: boolean;
  readonly invert?: boolean;
}

/** App trigger */
export interface AppTrigger {
  readonly _tag: "AppTrigger";
  readonly app: string;
  readonly activity?: string;
  readonly invert?: boolean;
}

/** Event types */
export type EventType =
  | "alarm_clock"
  | "alarm_done"
  | "battery_changed"
  | "display_off"
  | "display_on"
  | "notification"
  | "shake"
  | "variable_set";

/** Event trigger */
export interface EventTrigger {
  readonly _tag: "EventTrigger";
  readonly event: EventType;
  readonly pattern?: string;
  readonly invert?: boolean;
}

/** Notification trigger */
export interface NotificationTrigger {
  readonly _tag: "NotificationTrigger";
  readonly ownerApp?: string;
  readonly title?: string;
  readonly text?: string;
  readonly invert?: boolean;
}

/** State types */
export type StateType =
  | "airplane_mode"
  | "battery"
  | "bluetooth_connected"
  | "wifi_connected"
  | "variable_value";

/** State trigger */
export interface StateTrigger {
  readonly _tag: "StateTrigger";
  readonly state: StateType;
  readonly params?: Record<string, string>;
  readonly invert?: boolean;
}

/** Battery state trigger */
export interface BatteryStateTrigger {
  readonly _tag: "BatteryStateTrigger";
  readonly from: number;
  readonly to: number;
  readonly invert?: boolean;
}

/** Variable trigger */
export interface VariableTrigger {
  readonly _tag: "VariableTrigger";
  readonly name: string;
  readonly operator:
    | "equals"
    | "not_equals"
    | "matches"
    | "not_matches"
    | "less_than"
    | "greater_than"
    | "is_set"
    | "is_not_set";
  readonly value?: string;
  readonly invert?: boolean;
}

/** All trigger types */
export type Trigger =
  | TimeTrigger
  | LocationTrigger
  | WifiTrigger
  | BluetoothTrigger
  | AppTrigger
  | EventTrigger
  | NotificationTrigger
  | StateTrigger
  | BatteryStateTrigger
  | VariableTrigger;

// =============================================================================
// Action Types
// =============================================================================

/** Flash message action */
export interface FlashAction {
  readonly _tag: "FlashAction";
  readonly message: string;
  readonly long?: boolean;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Popup action */
export interface PopupAction {
  readonly _tag: "PopupAction";
  readonly title: string;
  readonly text: string;
  readonly timeout?: number;
  readonly background?: string;
  readonly layout?: string;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Say (TTS) action */
export interface SayAction {
  readonly _tag: "SayAction";
  readonly text: string;
  readonly engine?: string;
  readonly voice?: string;
  readonly stream?: "call" | "system" | "ringer" | "media" | "alarm" | "notification";
  readonly pitch?: number;
  readonly speed?: number;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Vibrate action */
export interface VibrateAction {
  readonly _tag: "VibrateAction";
  readonly duration: number;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Set variable action */
export interface SetVariableAction {
  readonly _tag: "SetVariableAction";
  readonly name: string;
  readonly value: string;
  readonly append?: boolean;
  readonly doMaths?: boolean;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Clear variable action */
export interface ClearVariableAction {
  readonly _tag: "ClearVariableAction";
  readonly name: string;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Perform task action */
export interface PerformTaskAction {
  readonly _tag: "PerformTaskAction";
  readonly taskName: string;
  readonly priority?: number;
  readonly param1?: string;
  readonly param2?: string;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Wait action */
export interface WaitAction {
  readonly _tag: "WaitAction";
  readonly hours?: number;
  readonly minutes?: number;
  readonly seconds?: number;
  readonly milliseconds?: number;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Stop action */
export interface StopAction {
  readonly _tag: "StopAction";
  readonly withError?: boolean;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** If condition */
export interface IfAction {
  readonly _tag: "IfAction";
  readonly lhs: string;
  readonly operator:
    | "eq"
    | "neq"
    | "lt"
    | "gt"
    | "lte"
    | "gte"
    | "matches"
    | "not_matches"
    | "set"
    | "not_set"
    | "contains"
    | "not_contains";
  readonly rhs?: string;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Else action */
export interface ElseAction {
  readonly _tag: "ElseAction";
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** End If action */
export interface EndIfAction {
  readonly _tag: "EndIfAction";
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** HTTP Request action */
export interface HttpRequestAction {
  readonly _tag: "HttpRequestAction";
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly outputVariable?: string;
  readonly timeout?: number;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Shell action */
export interface ShellAction {
  readonly _tag: "ShellAction";
  readonly command: string;
  readonly root?: boolean;
  readonly timeout?: number;
  readonly outputVariable?: string;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** JavaScriptlet action */
export interface JavaScriptletAction {
  readonly _tag: "JavaScriptletAction";
  readonly code: string;
  readonly autoExit?: boolean;
  readonly timeout?: number;
  readonly libraries?: readonly string[];
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** JavaScript action (from file) */
export interface JavaScriptAction {
  readonly _tag: "JavaScriptAction";
  readonly path: string;
  readonly timeout?: number;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Show scene action */
export interface ShowSceneAction {
  readonly _tag: "ShowSceneAction";
  readonly name: string;
  readonly displayAs?:
    | "Overlay"
    | "OverBlocking"
    | "OverBlockFullDisplay"
    | "Dialog"
    | "DialogBlur"
    | "DialogDim"
    | "ActivityFullWindow"
    | "ActivityFullDisplay"
    | "ActivityFullDisplayNoTitle";
  readonly hOffset?: number;
  readonly vOffset?: number;
  readonly showExitIcon?: boolean;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Hide scene action */
export interface HideSceneAction {
  readonly _tag: "HideSceneAction";
  readonly name: string;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Set WiFi action */
export interface SetWifiAction {
  readonly _tag: "SetWifiAction";
  readonly enabled: boolean;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Set Bluetooth action */
export interface SetBluetoothAction {
  readonly _tag: "SetBluetoothAction";
  readonly enabled: boolean;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Set volume action */
export interface SetVolumeAction {
  readonly _tag: "SetVolumeAction";
  readonly stream:
    | "alarm"
    | "bluetooth"
    | "call"
    | "dtmf"
    | "media"
    | "notification"
    | "ringer"
    | "system";
  readonly level: number;
  readonly display?: boolean;
  readonly sound?: boolean;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Browse URL action */
export interface BrowseUrlAction {
  readonly _tag: "BrowseUrlAction";
  readonly url: string;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Send SMS action */
export interface SendSmsAction {
  readonly _tag: "SendSmsAction";
  readonly number: string;
  readonly message: string;
  readonly store?: boolean;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Write file action */
export interface WriteFileAction {
  readonly _tag: "WriteFileAction";
  readonly path: string;
  readonly text: string;
  readonly append?: boolean;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Read file action */
export interface ReadFileAction {
  readonly _tag: "ReadFileAction";
  readonly path: string;
  readonly outputVariable?: string;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Launch app action */
export interface LaunchAppAction {
  readonly _tag: "LaunchAppAction";
  readonly app: string;
  readonly data?: string;
  readonly excludeFromRecents?: boolean;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Profile status action */
export interface ProfileStatusAction {
  readonly _tag: "ProfileStatusAction";
  readonly name: string;
  readonly enabled: boolean;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** Notify action */
export interface NotifyAction {
  readonly _tag: "NotifyAction";
  readonly title: string;
  readonly text: string;
  readonly icon?: string;
  readonly number?: number;
  readonly priority?: "low" | "normal" | "high";
  readonly permanent?: boolean;
  readonly sound?: string;
  readonly vibrate?: boolean;
  readonly label?: string;
  readonly continueOnError?: boolean;
}

/** All action types */
export type Action =
  | FlashAction
  | PopupAction
  | SayAction
  | VibrateAction
  | SetVariableAction
  | ClearVariableAction
  | PerformTaskAction
  | WaitAction
  | StopAction
  | IfAction
  | ElseAction
  | EndIfAction
  | HttpRequestAction
  | ShellAction
  | JavaScriptletAction
  | JavaScriptAction
  | ShowSceneAction
  | HideSceneAction
  | SetWifiAction
  | SetBluetoothAction
  | SetVolumeAction
  | BrowseUrlAction
  | SendSmsAction
  | WriteFileAction
  | ReadFileAction
  | LaunchAppAction
  | ProfileStatusAction
  | NotifyAction;

// =============================================================================
// Task Definition
// =============================================================================

/** Collision handling mode for tasks */
export type CollisionHandling = "abort_new" | "abort_existing" | "run_both";

/** Task definition */
export interface Task {
  readonly name: string;
  readonly actions: readonly Action[];
  readonly collision?: CollisionHandling;
  readonly priority?: number;
  readonly keepAwake?: boolean;
  readonly description?: string;
}

// =============================================================================
// Profile Definition
// =============================================================================

/** Profile definition */
export interface Profile {
  readonly name: string;
  readonly triggers: readonly [Trigger, ...Trigger[]];
  readonly entry: string | Task;
  readonly exit?: string | Task;
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly description?: string;
}

// =============================================================================
// Project Definition
// =============================================================================

/** Project definition */
export interface Project {
  readonly name: string;
  readonly profiles?: readonly Profile[];
  readonly tasks?: readonly Task[];
  readonly description?: string;
}

// =============================================================================
// Helper Functions for Building Profiles
// =============================================================================

/** Create a time trigger */
export const time = (
  from: TimeSpec,
  options?: {
    to?: TimeSpec;
    repeatMinutes?: number;
    days?: DayOfWeek[];
    months?: Month[];
    invert?: boolean;
  }
): TimeTrigger => ({
  _tag: "TimeTrigger",
  from,
  to: options?.to,
  repeatMinutes: options?.repeatMinutes,
  days: options?.days,
  months: options?.months,
  invert: options?.invert,
});

/** Create a location trigger */
export const location = (
  lat: number,
  lon: number,
  radius: number,
  invert?: boolean
): LocationTrigger => ({
  _tag: "LocationTrigger",
  latitude: lat,
  longitude: lon,
  radius,
  invert,
});

/** Create a WiFi trigger */
export const wifi = (options?: {
  ssid?: string;
  mac?: string;
  connected?: boolean;
  invert?: boolean;
}): WifiTrigger => ({
  _tag: "WifiTrigger",
  ssid: options?.ssid ?? "*",
  mac: options?.mac,
  connected: options?.connected ?? true,
  invert: options?.invert,
});

/** Create a Bluetooth trigger */
export const bluetooth = (options?: {
  name?: string;
  address?: string;
  connected?: boolean;
  invert?: boolean;
}): BluetoothTrigger => ({
  _tag: "BluetoothTrigger",
  name: options?.name,
  address: options?.address,
  connected: options?.connected ?? true,
  invert: options?.invert,
});

/** Create an app trigger */
export const app = (
  packageOrLabel: string,
  options?: {
    activity?: string;
    invert?: boolean;
  }
): AppTrigger => ({
  _tag: "AppTrigger",
  app: packageOrLabel,
  activity: options?.activity,
  invert: options?.invert,
});

/** Create a battery state trigger */
export const battery = (
  from: number,
  to: number,
  invert?: boolean
): BatteryStateTrigger => ({
  _tag: "BatteryStateTrigger",
  from,
  to,
  invert,
});

/** Create a variable trigger */
export const variable = (
  name: string,
  operator: VariableTrigger["operator"],
  value?: string,
  invert?: boolean
): VariableTrigger => ({
  _tag: "VariableTrigger",
  name,
  operator,
  value,
  invert,
});

// ----------------------------- Action helpers -------------------------------

/** Create a flash action */
export const flash = (message: string, long = false): FlashAction => ({
  _tag: "FlashAction",
  message,
  long,
});

/** Create a set variable action */
export const setVar = (
  name: string,
  value: string,
  options?: {
    append?: boolean;
    doMaths?: boolean;
  }
): SetVariableAction => ({
  _tag: "SetVariableAction",
  name,
  value,
  append: options?.append,
  doMaths: options?.doMaths,
});

/** Create a wait action */
export const wait = (options: {
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
}): WaitAction => ({
  _tag: "WaitAction",
  ...options,
});

/** Create a perform task action */
export const performTask = (
  taskName: string,
  options?: {
    priority?: number;
    param1?: string;
    param2?: string;
  }
): PerformTaskAction => ({
  _tag: "PerformTaskAction",
  taskName,
  priority: options?.priority,
  param1: options?.param1,
  param2: options?.param2,
});

/** Create a shell action */
export const shell = (
  command: string,
  options?: {
    root?: boolean;
    timeout?: number;
    outputVariable?: string;
  }
): ShellAction => ({
  _tag: "ShellAction",
  command,
  root: options?.root,
  timeout: options?.timeout,
  outputVariable: options?.outputVariable,
});

/** Create a JavaScriptlet action */
export const javascriptlet = (
  code: string,
  options?: {
    autoExit?: boolean;
    timeout?: number;
    libraries?: string[];
  }
): JavaScriptletAction => ({
  _tag: "JavaScriptletAction",
  code,
  autoExit: options?.autoExit ?? true,
  timeout: options?.timeout,
  libraries: options?.libraries,
});

/** Create an HTTP request action */
export const http = (
  method: HttpRequestAction["method"],
  url: string,
  options?: {
    headers?: Record<string, string>;
    body?: string;
    outputVariable?: string;
    timeout?: number;
  }
): HttpRequestAction => ({
  _tag: "HttpRequestAction",
  method,
  url,
  headers: options?.headers,
  body: options?.body,
  outputVariable: options?.outputVariable ?? "%http_data",
  timeout: options?.timeout ?? 30,
});

// ----------------------------- Task/Profile builders ------------------------

/** Create a task */
export const task = (
  name: string,
  actions: Action[],
  options?: {
    collision?: CollisionHandling;
    priority?: number;
    keepAwake?: boolean;
    description?: string;
  }
): Task => ({
  name,
  actions,
  collision: options?.collision ?? "abort_new",
  priority: options?.priority ?? 5,
  keepAwake: options?.keepAwake ?? false,
  description: options?.description,
});

/** Create a profile */
export const profile = (
  name: string,
  triggers: [Trigger, ...Trigger[]],
  entry: string | Task,
  options?: {
    exit?: string | Task;
    priority?: number;
    enabled?: boolean;
    description?: string;
  }
): Profile => ({
  name,
  triggers,
  entry,
  exit: options?.exit,
  priority: options?.priority ?? 100,
  enabled: options?.enabled ?? true,
  description: options?.description,
});

/** Create a project */
export const project = (
  name: string,
  options?: {
    profiles?: Profile[];
    tasks?: Task[];
    description?: string;
  }
): Project => ({
  name,
  profiles: options?.profiles ?? [],
  tasks: options?.tasks ?? [],
  description: options?.description,
});
