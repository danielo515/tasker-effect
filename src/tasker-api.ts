/**
 * @module tasker-api
 * @description Type-safe bindings for Tasker's JavaScript API
 *
 * These types and implementations wrap Tasker's global functions
 * available in JavaScriptlet actions and WebView elements.
 *
 * @see https://tasker.joaoapps.com/userguide/en/javascript.html
 */

import { Effect, Context, Layer, Data } from "effect";

// =============================================================================
// Type Definitions
// =============================================================================

/** Audio stream types for volume and playback functions */
export type AudioStream =
  | "call"
  | "system"
  | "ringer"
  | "media"
  | "alarm"
  | "notification";

/** Audio recording source types */
export type AudioSource = "def" | "mic" | "call" | "callout" | "callin";

/** Audio recording codec types */
export type AudioCodec = "amrn" | "amrw" | "aac";

/** Audio recording format types */
export type AudioFormat = "mp4" | "3gpp" | "amrn" | "amrw" | "amrr";

/** Hardware button names */
export type ButtonName =
  | "back"
  | "call"
  | "camera"
  | "endcall"
  | "menu"
  | "volup"
  | "voldown"
  | "search";

/** D-pad direction types */
export type DpadDirection = "up" | "down" | "left" | "right" | "press";

/** Media control actions */
export type MediaAction = "next" | "pause" | "prev" | "toggle" | "stop";

/** Silent mode options */
export type SilentMode = "off" | "vibrate" | "on";

/** Stay on mode options */
export type StayOnMode = "never" | "ac" | "usb" | "any";

/** Reboot type options */
export type RebootType = "normal" | "recovery" | "bootloader";

/** Location source options */
export type LocationSource = "gps" | "net" | "any";

/** Intent target component types */
export type IntentTarget = "receiver" | "activity" | "service";

/** Intent category types */
export type IntentCategory =
  | "none"
  | "alt"
  | "browsable"
  | "cardock"
  | "deskdock"
  | "home"
  | "info"
  | "launcher"
  | "preference"
  | "selectedalt"
  | "tab"
  | "test";

/** Settings screen names */
export type SettingsScreen =
  | "all"
  | "accessibility"
  | "addacount"
  | "airplanemode"
  | "apn"
  | "app"
  | "batteryinfo"
  | "appmanage"
  | "bluetooth"
  | "date"
  | "deviceinfo"
  | "dictionary"
  | "display"
  | "inputmethod"
  | "internalstorage"
  | "locale"
  | "location"
  | "memorycard"
  | "networkoperator"
  | "powerusage"
  | "privacy"
  | "quicklaunch"
  | "security"
  | "mobiledata"
  | "search"
  | "sound"
  | "sync"
  | "wifi"
  | "wifiip"
  | "wireless";

/** Scene display options */
export type SceneDisplayAs =
  | "Overlay"
  | "OverBlocking"
  | "OverBlockFullDisplay"
  | "Dialog"
  | "DialogBlur"
  | "DialogDim"
  | "ActivityFullWindow"
  | "ActivityFullDisplay"
  | "ActivityFullDisplayNoTitle";

/** Conversion types for the convert function */
export type ConversionType =
  | "byteToKbyte"
  | "byteToMbyte"
  | "byteToGbyte"
  | "datetimeToSec"
  | "secToDatetime"
  | "secToDatetimeM"
  | "secToDatetimeL"
  | "htmlToText"
  | "celsToFahr"
  | "fahrToCels"
  | "inchToCent"
  | "metreToFeet"
  | "feetToMetre"
  | "kgToPound"
  | "poundToKg"
  | "kmToMile"
  | "mileToKm"
  | "urlDecode"
  | "urlEncode"
  | "binToDec"
  | "decToBin"
  | "hexToDec"
  | "decToHex"
  | "base64encode"
  | "base64decode"
  | "toMd5"
  | "toSha1";

/** Image filter modes */
export type ImageFilterMode =
  | "bw"
  | "eblue"
  | "egreen"
  | "ered"
  | "grey"
  | "alpha";

/** Language model for voice input */
export type LanguageModel = "web" | "free";

/** Camera options */
export type CameraOption = 0 | 1; // 0 = rear, 1 = front

/** Element text position */
export type ElementTextPosition = "repl" | "start" | "end";

// =============================================================================
// Errors
// =============================================================================

/** Error thrown when a Tasker function fails */
export class TaskerError extends Data.TaggedError("TaskerError")<{
  readonly function: string;
  readonly message: string;
}> {}

/** Error thrown when Tasker is not available (e.g., running off-device) */
export class TaskerNotAvailableError extends Data.TaggedError(
  "TaskerNotAvailableError"
)<{
  readonly message: string;
}> {}

// =============================================================================
// Tasker Service Interface
// =============================================================================

/**
 * Service interface for Tasker API
 */
export interface TaskerService {
  // Volume Functions
  readonly alarmVol: (
    level: number,
    display?: boolean,
    sound?: boolean
  ) => Effect.Effect<boolean, TaskerError>;

  readonly mediaVol: (
    level: number,
    display?: boolean,
    sound?: boolean
  ) => Effect.Effect<boolean, TaskerError>;

  readonly ringerVol: (
    level: number,
    display?: boolean,
    sound?: boolean
  ) => Effect.Effect<boolean, TaskerError>;

  // Display
  readonly flash: (message: string) => Effect.Effect<void, TaskerError>;
  readonly flashLong: (message: string) => Effect.Effect<void, TaskerError>;

  readonly popup: (
    title: string,
    text: string,
    showOverKeyguard?: boolean,
    background?: string,
    layout?: string,
    timeoutSecs?: number
  ) => Effect.Effect<boolean, TaskerError>;

  // Variables
  readonly global: (varName: string) => Effect.Effect<string, TaskerError>;
  readonly setGlobal: (
    varName: string,
    newValue: string
  ) => Effect.Effect<void, TaskerError>;
  readonly local: (varName: string) => Effect.Effect<string, TaskerError>;
  readonly setLocal: (
    varName: string,
    newValue: string
  ) => Effect.Effect<void, TaskerError>;

  // Tasks
  readonly performTask: (
    taskName: string,
    priority?: number,
    parameterOne?: string,
    parameterTwo?: string
  ) => Effect.Effect<boolean, TaskerError>;

  readonly profileActive: (
    profileName: string
  ) => Effect.Effect<boolean, TaskerError>;

  readonly enableProfile: (
    name: string,
    enable: boolean
  ) => Effect.Effect<boolean, TaskerError>;

  readonly taskRunning: (
    taskName: string
  ) => Effect.Effect<boolean, TaskerError>;

  // Files
  readonly readFile: (path: string) => Effect.Effect<string, TaskerError>;
  readonly writeFile: (
    path: string,
    text: string,
    append?: boolean
  ) => Effect.Effect<boolean, TaskerError>;
  readonly createDir: (
    dirPath: string,
    createParent?: boolean,
    useRoot?: boolean
  ) => Effect.Effect<boolean, TaskerError>;

  // Shell
  readonly shell: (
    command: string,
    asRoot?: boolean,
    timeoutSecs?: number
  ) => Effect.Effect<string | undefined, TaskerError>;

  // System
  readonly setWifi: (setOn: boolean) => Effect.Effect<boolean, TaskerError>;
  readonly setBT: (setOn: boolean) => Effect.Effect<boolean, TaskerError>;
  readonly setWallpaper: (path: string) => Effect.Effect<boolean, TaskerError>;
  readonly vibrate: (
    durationMilliseconds: number
  ) => Effect.Effect<void, TaskerError>;
  readonly say: (
    text: string,
    engine?: string,
    voice?: string,
    stream?: AudioStream,
    pitch?: number,
    speed?: number
  ) => Effect.Effect<boolean, TaskerError>;

  // Utilities
  readonly wait: (
    durationMilliseconds: number
  ) => Effect.Effect<void, TaskerError>;
  readonly exit: () => Effect.Effect<void, TaskerError>;
  readonly browseURL: (url: string) => Effect.Effect<boolean, TaskerError>;
  readonly sendSMS: (
    number: string,
    text: string,
    storeInMessagingApp?: boolean
  ) => Effect.Effect<boolean, TaskerError>;

  // Check if on device
  readonly isOnDevice: () => Effect.Effect<boolean, never>;
}

/** Tasker service tag */
export class Tasker extends Context.Tag("Tasker")<Tasker, TaskerService>() {}

// =============================================================================
// Global declarations for Tasker environment
// =============================================================================

declare const alarmVol: (
  level: number,
  display: boolean,
  sound: boolean
) => boolean;
declare const mediaVol: (
  level: number,
  display: boolean,
  sound: boolean
) => boolean;
declare const ringerVol: (
  level: number,
  display: boolean,
  sound: boolean
) => boolean;
declare const flash: (message: string) => void;
declare const flashLong: (message: string) => void;
declare const popup: (
  title: string,
  text: string,
  showOverKeyguard: boolean,
  background: string | undefined,
  layout: string | undefined,
  timeoutSecs: number
) => boolean;
declare const global: (varName: string) => string;
declare const setGlobal: (varName: string, newValue: string) => void;
declare const local: (varName: string) => string;
declare const setLocal: (varName: string, newValue: string) => void;
declare const performTask: (
  taskName: string,
  priority: number,
  parameterOne: string | undefined,
  parameterTwo: string | undefined
) => boolean;
declare const profileActive: (profileName: string) => boolean;
declare const enableProfile: (name: string, enable: boolean) => boolean;
declare const taskRunning: (taskName: string) => boolean;
declare const readFile: (path: string) => string;
declare const writeFile: (
  path: string,
  text: string,
  append: boolean
) => boolean;
declare const createDir: (
  dirPath: string,
  createParent: boolean,
  useRoot: boolean
) => boolean;
declare const shell: (
  command: string,
  asRoot: boolean,
  timeoutSecs: number
) => string | undefined;
declare const setWifi: (setOn: boolean) => boolean;
declare const setBT: (setOn: boolean) => boolean;
declare const setWallpaper: (path: string) => boolean;
declare const vibrate: (durationMilliseconds: number) => void;
declare const say: (
  text: string,
  engine: string | undefined,
  voice: string | undefined,
  stream: string,
  pitch: number,
  speed: number
) => boolean;
declare const wait: (durationMilliseconds: number) => void;
declare const exit: () => void;
declare const browseURL: (url: string) => boolean;
declare const sendSMS: (
  number: string,
  text: string,
  storeInMessagingApp: boolean
) => boolean;

// =============================================================================
// Helper Functions
// =============================================================================

const wrapBool =
  <Args extends unknown[]>(
    fnName: string,
    fn: (...args: Args) => boolean
  ) =>
  (...args: Args): Effect.Effect<boolean, TaskerError> =>
    Effect.try({
      try: () => fn(...args),
      catch: (e) =>
        new TaskerError({
          function: fnName,
          message: String(e),
        }),
    });

const wrapVoid =
  <Args extends unknown[]>(
    fnName: string,
    fn: (...args: Args) => void
  ) =>
  (...args: Args): Effect.Effect<void, TaskerError> =>
    Effect.try({
      try: () => fn(...args),
      catch: (e) =>
        new TaskerError({
          function: fnName,
          message: String(e),
        }),
    });

const wrapString =
  <Args extends unknown[]>(
    fnName: string,
    fn: (...args: Args) => string
  ) =>
  (...args: Args): Effect.Effect<string, TaskerError> =>
    Effect.try({
      try: () => fn(...args),
      catch: (e) =>
        new TaskerError({
          function: fnName,
          message: String(e),
        }),
    });

// =============================================================================
// Live Implementation (for on-device use)
// =============================================================================

/** Live implementation that calls actual Tasker functions */
export const TaskerLive = Layer.succeed(Tasker, {
  alarmVol: (level, display = false, sound = false) =>
    wrapBool("alarmVol", alarmVol)(level, display, sound),

  mediaVol: (level, display = false, sound = false) =>
    wrapBool("mediaVol", mediaVol)(level, display, sound),

  ringerVol: (level, display = false, sound = false) =>
    wrapBool("ringerVol", ringerVol)(level, display, sound),

  flash: wrapVoid("flash", flash),
  flashLong: wrapVoid("flashLong", flashLong),

  popup: (
    title,
    text,
    showOverKeyguard = false,
    background,
    layout,
    timeoutSecs = 0
  ) =>
    wrapBool("popup", popup)(
      title,
      text,
      showOverKeyguard,
      background,
      layout,
      timeoutSecs
    ),

  global: wrapString("global", global),
  setGlobal: wrapVoid("setGlobal", setGlobal),
  local: wrapString("local", local),
  setLocal: wrapVoid("setLocal", setLocal),

  performTask: (taskName, priority = 5, parameterOne, parameterTwo) =>
    wrapBool("performTask", performTask)(
      taskName,
      priority,
      parameterOne,
      parameterTwo
    ),

  profileActive: wrapBool("profileActive", profileActive),
  enableProfile: wrapBool("enableProfile", enableProfile),
  taskRunning: wrapBool("taskRunning", taskRunning),

  readFile: wrapString("readFile", readFile),
  writeFile: (path, text, append = false) =>
    wrapBool("writeFile", writeFile)(path, text, append),
  createDir: (dirPath, createParent = false, useRoot = false) =>
    wrapBool("createDir", createDir)(dirPath, createParent, useRoot),

  shell: (command, asRoot = false, timeoutSecs = 60) =>
    Effect.try({
      try: () => shell(command, asRoot, timeoutSecs),
      catch: (e) =>
        new TaskerError({
          function: "shell",
          message: String(e),
        }),
    }),

  setWifi: wrapBool("setWifi", setWifi),
  setBT: wrapBool("setBT", setBT),
  setWallpaper: wrapBool("setWallpaper", setWallpaper),
  vibrate: wrapVoid("vibrate", vibrate),

  say: (text, engine, voice, stream = "media", pitch = 5, speed = 5) =>
    wrapBool("say", say)(text, engine, voice, stream, pitch, speed),

  wait: wrapVoid("wait", wait),
  exit: wrapVoid("exit", exit),
  browseURL: wrapBool("browseURL", browseURL),
  sendSMS: (number, text, storeInMessagingApp = true) =>
    wrapBool("sendSMS", sendSMS)(number, text, storeInMessagingApp),

  isOnDevice: () =>
    Effect.sync(() => {
      try {
        return global("sdk") !== "";
      } catch {
        return false;
      }
    }),
});

// =============================================================================
// Mock Implementation (for testing/development)
// =============================================================================

/** Mock implementation for testing without Tasker */
export const TaskerMock = Layer.succeed(Tasker, {
  alarmVol: () => Effect.succeed(true),
  mediaVol: () => Effect.succeed(true),
  ringerVol: () => Effect.succeed(true),
  flash: (msg) => Effect.sync(() => console.log(`[FLASH] ${msg}`)),
  flashLong: (msg) => Effect.sync(() => console.log(`[FLASH_LONG] ${msg}`)),
  popup: () => Effect.succeed(true),
  global: () => Effect.succeed(""),
  setGlobal: () => Effect.void,
  local: () => Effect.succeed(""),
  setLocal: () => Effect.void,
  performTask: () => Effect.succeed(true),
  profileActive: () => Effect.succeed(false),
  enableProfile: () => Effect.succeed(true),
  taskRunning: () => Effect.succeed(false),
  readFile: () => Effect.succeed(""),
  writeFile: () => Effect.succeed(true),
  createDir: () => Effect.succeed(true),
  shell: () => Effect.succeed(""),
  setWifi: () => Effect.succeed(true),
  setBT: () => Effect.succeed(true),
  setWallpaper: () => Effect.succeed(true),
  vibrate: () => Effect.void,
  say: () => Effect.succeed(true),
  wait: () => Effect.void,
  exit: () => Effect.void,
  browseURL: () => Effect.succeed(true),
  sendSMS: () => Effect.succeed(true),
  isOnDevice: () => Effect.succeed(false),
});
