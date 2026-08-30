/**
 * @module tasker-api
 * @description Type-safe bindings for Tasker's JavaScript API.
 *
 * Tasker exposes a set of global functions inside JavaScript/JavaScriptlet
 * actions and WebView scenes. This module wraps every documented function in
 * an Effect-based service so programs can be written, tested and composed
 * off-device, then bundled and executed on-device.
 *
 * @see https://tasker.joaoapps.com/userguide/en/javascript.html
 */

import { Effect, Layer, Schema } from "effect";

// =============================================================================
// Option types (documented string/int enums)
// =============================================================================

/** Audio stream names accepted by say(), musicPlay(), etc. */
export type AudioStream =
  | "call"
  | "system"
  | "ringer"
  | "media"
  | "alarm"
  | "notification";

/** Audio recording source */
export type AudioSource = "def" | "mic" | "call" | "callout" | "callin";

/** Audio recording codec */
export type AudioCodec = "amrn" | "amrw" | "aac";

/** Audio recording file format */
export type AudioFormat = "mp4" | "3gpp" | "amrn" | "amrw";

/** Hardware button names for button() (root required) */
export type ButtonName =
  | "back"
  | "call"
  | "camera"
  | "endcall"
  | "menu"
  | "volup"
  | "voldown"
  | "search";

/** D-pad directions for dpad() (root required) */
export type DpadDirection = "up" | "down" | "left" | "right" | "press";

/** Media control actions for mediaControl() */
export type MediaAction = "next" | "pause" | "prev" | "toggle" | "stop" | "play";

/** Ringer modes for silentMode() */
export type SilentMode = "off" | "vibrate" | "on";

/** Modes for stayOn() */
export type StayOnMode = "never" | "ac" | "usb" | "any";

/** Reboot types for reboot() (root required) */
export type RebootType = "normal" | "recovery" | "bootloader";

/** Location providers for getLocation() */
export type LocationSource = "gps" | "net" | "any";

/** Intent target components for sendIntent() */
export type IntentTarget = "receiver" | "activity" | "service";

/** Android settings screens for settings() */
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

/** Scene display modes for showScene() */
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

/** Conversions supported by convert() */
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

/** Image filter modes for filterImage() */
export type ImageFilterMode = "bw" | "eblue" | "egreen" | "ered" | "grey" | "alpha";

/** Rotation direction for rotateImage() */
export type RotateDirection = "left" | "right";

/** Language models for getVoice() */
export type LanguageModel = "web" | "free";

/** Camera selector for takePhoto(): 0 = rear, 1 = front */
export type CameraId = 0 | 1;

/** Scene element text position for elemText() */
export type ElementTextPosition = "repl" | "start" | "end";

/** Scene element orientation for elemPosition() */
export type SceneOrientation = "port" | "land";

// =============================================================================
// Errors
// =============================================================================

/** A Tasker builtin threw while executing */
export class TaskerCallError extends Schema.TaggedError<TaskerCallError>()(
  "TaskerCallError",
  {
    function: Schema.String,
    message: Schema.String,
  }
) {}

/**
 * The Tasker builtin is not present in the current JavaScript environment
 * (e.g. running under Node/Bun instead of on-device).
 */
export class TaskerNotAvailableError extends Schema.TaggedError<TaskerNotAvailableError>()(
  "TaskerNotAvailableError",
  {
    function: Schema.String,
    message: Schema.String,
  }
) {}

/** Union of errors any Tasker binding can fail with */
export type TaskerApiError = TaskerCallError | TaskerNotAvailableError;

// =============================================================================
// Raw API surface — single source of truth for every documented function
// =============================================================================

/**
 * The raw global functions Tasker injects into its JavaScript environment,
 * with their documented signatures. Optional parameters have documented
 * defaults inside Tasker.
 */
export interface TaskerRawApi {
  // --- Variables ---------------------------------------------------------
  /** Retrieve the value of a Tasker global variable (without the % prefix) */
  global(varName: string): string | undefined;
  /** Set a Tasker global user variable */
  setGlobal(varName: string, newValue: string): void;
  /** Retrieve a scene-local variable */
  local(varName: string): string | undefined;
  /** Set a scene-local variable */
  setLocal(varName: string, newValue: string): void;

  // --- UI & display ------------------------------------------------------
  /** Show a short toast message */
  flash(message: string): void;
  /** Show a long toast message */
  flashLong(message: string): void;
  /** Show a popup dialog; blocks until dismissed or timeout */
  popup(
    title: string,
    text: string,
    showOverKeyguard?: boolean,
    background?: string,
    layout?: string,
    timeoutSecs?: number
  ): boolean;
  /** Display a named scene */
  showScene(
    name: string,
    displayAs?: SceneDisplayAs,
    hoffset?: number,
    voffset?: number,
    showExitIcon?: boolean,
    waitForExit?: boolean
  ): boolean;
  /** Hide a visible scene */
  hideScene(sceneName: string): boolean;
  /** Create a scene without displaying it */
  createScene(sceneName: string): boolean;
  /** Hide then destroy a scene */
  destroyScene(sceneName: string): boolean;
  /** Go to the Android home screen (optionally a particular screen number) */
  goHome(screenNum?: number): void;

  // --- Scene elements ----------------------------------------------------
  /** Set the text of a scene element */
  elemText(scene: string, element: string, position: ElementTextPosition, text: string): boolean;
  /** Set the text colour (AARRGGBB) of a scene element */
  elemTextColour(scene: string, element: string, colour: string): boolean;
  /** Set the text size of a scene element */
  elemTextSize(scene: string, element: string, size: number): boolean;
  /** Set the background colour (AARRGGBB gradient) of a scene element */
  elemBackColour(scene: string, element: string, startColour: string, endColour: string): boolean;
  /** Set the border of a scene element */
  elemBorder(scene: string, element: string, width: number, colour: string): boolean;
  /** Move a scene element */
  elemPosition(
    scene: string,
    element: string,
    orientation: SceneOrientation,
    x: number,
    y: number,
    animMS: number
  ): boolean;
  /** Show/hide a scene element */
  elemVisibility(scene: string, element: string, visible: boolean, animationTimeMS: number): boolean;

  // --- Volume ------------------------------------------------------------
  /** Set alarm volume */
  alarmVol(level: number, display?: boolean, sound?: boolean): boolean;
  /** Set system volume */
  systemVol(level: number, display?: boolean, sound?: boolean): boolean;
  /** Set media volume */
  mediaVol(level: number, display?: boolean, sound?: boolean): boolean;
  /** Set ringer volume */
  ringerVol(level: number, display?: boolean, sound?: boolean): boolean;
  /** Set notification volume */
  notificationVol(level: number, display?: boolean, sound?: boolean): boolean;
  /** Set in-call volume */
  callVol(level: number, display?: boolean, sound?: boolean): boolean;
  /** Set DTMF volume */
  dtmfVol(level: number, display?: boolean, sound?: boolean): boolean;
  /** Set Bluetooth voice volume */
  btVoiceVol(level: number, display?: boolean, sound?: boolean): boolean;

  // --- Audio record & playback ------------------------------------------
  /** Start recording audio (asynchronous) */
  audioRecord(destPath: string, source: AudioSource, codec: AudioCodec, format: AudioFormat): boolean;
  /** Stop an active audio recording */
  audioRecordStop(): boolean;
  /** Play a music file (asynchronous) */
  musicPlay(path: string, offsetSecs?: number, loop?: boolean, stream?: AudioStream): boolean;
  /** Stop music playback started with musicPlay() */
  musicStop(): boolean;
  /** Skip forwards in the playing track */
  musicSkip(seconds: number): boolean;
  /** Skip backwards in the playing track */
  musicBack(seconds: number): boolean;
  /** Send a media control action to the foreground media app */
  mediaControl(action: MediaAction): boolean;
  /** Speak text with TTS. pitch/speed range 1-10 */
  say(
    text: string,
    engine?: string,
    voice?: string,
    stream?: AudioStream,
    pitch?: number,
    speed?: number
  ): boolean;

  // --- Phone & messaging -------------------------------------------------
  /** Make a phone call */
  call(num: string, autoDial?: boolean): boolean;
  /** End the current call */
  endCall(): boolean;
  /** Auto-accept an incoming call */
  takeCall(): boolean;
  /** Block outgoing calls matching the pattern */
  callBlock(numMatch: string, showInfo?: boolean): boolean;
  /** Divert outgoing calls matching the pattern */
  callDivert(fromMatch: string, to: string, showInfo?: boolean): boolean;
  /** Stop blocking/diverting calls matching the pattern */
  callRevert(numMatch: string): boolean;
  /** Send an SMS */
  sendSMS(number: string, text: string, storeInMessagingApp?: boolean): boolean;
  /** Open the SMS composition dialog (asynchronous) */
  composeSMS(to: string, message: string): boolean;
  /** Open the MMS composition dialog (asynchronous) */
  composeMMS(to: string, subject: string, message: string, attachmentPath?: string): boolean;
  /** Open the email composition dialog (asynchronous) */
  composeEmail(to: string, subject: string, message: string): boolean;

  // --- Files -------------------------------------------------------------
  /** Read the contents of a text file */
  readFile(path: string): string;
  /** Write text to a file */
  writeFile(path: string, text: string, append?: boolean): boolean;
  /** Delete a file, optionally shredding it 1-10 times */
  deleteFile(filePath: string, shredTimes?: number, useRoot?: boolean): boolean;
  /** Create a directory */
  createDir(dirPath: string, createParent?: boolean, useRoot?: boolean): boolean;
  /** Delete a directory */
  deleteDir(dirPath: string, recurse?: boolean, useRoot?: boolean): boolean;
  /** List files in a directory, newline-separated */
  listFiles(dirPath: string, hiddenToo?: boolean): string;
  /** Zip a file or directory (compression level 1-9) */
  zip(path: string, level?: number, deleteOriginalAfter?: boolean): boolean;
  /** Unzip an archive in place */
  unzip(zipPath: string, deleteZipAfter?: boolean): boolean;

  // --- Encryption --------------------------------------------------------
  /** Encrypt a file */
  encryptFile(path: string, keyName: string, rememberKey?: boolean, shredOriginal?: boolean): boolean;
  /** Decrypt a file */
  decryptFile(path: string, key: string, removeKey?: boolean): boolean;
  /** Encrypt the files in a directory */
  encryptDir(path: string, keyName: string, rememberKey?: boolean, shredOriginal?: boolean): boolean;
  /** Decrypt the files in a directory */
  decryptDir(path: string, key: string, removeKey?: boolean): boolean;
  /** Store an encryption passphrase under a key name */
  setKey(keyName: string, passphrase: string): boolean;
  /** Clear a stored passphrase */
  clearKey(keyName: string): boolean;
  /** Show a passphrase entry dialog; blocks until dismissed or timeout */
  enterKey(
    title: string,
    keyName: string,
    showOverKeyguard?: boolean,
    confirm?: boolean,
    background?: string,
    layout?: string,
    timeoutSecs?: number
  ): boolean;

  // --- Images ------------------------------------------------------------
  /** Load an image into Tasker's image buffer (file:// URIs) */
  loadImage(uri: string): boolean;
  /** Save the buffered image */
  saveImage(path: string, qualityPercent: number, deleteFromMemoryAfter?: boolean): boolean;
  /** Scale the buffered image */
  resizeImage(width: number, height: number): boolean;
  /** Rotate the buffered image by 45/90/135/180 degrees */
  rotateImage(dir: RotateDirection, degrees: number): boolean;
  /** Flip the buffered image */
  flipImage(horizontal: boolean): boolean;
  /** Crop the buffered image by percentages from each edge */
  cropImage(
    fromLeftPercent: number,
    fromRightPercent: number,
    fromTopPercent: number,
    fromBottomPercent: number
  ): boolean;
  /** Apply a filter to the buffered image */
  filterImage(mode: ImageFilterMode, value?: number): boolean;
  /** Take a photo with the given camera */
  takePhoto(camera: CameraId, fileName: string, resolution: string, insertGallery?: boolean): boolean;
  /** Set the home screen wallpaper */
  setWallpaper(path: string): boolean;

  // --- Display & settings -------------------------------------------------
  /** Set the display auto-off timeout */
  displayTimeout(hours: number, minutes: number, seconds: number): boolean;
  /** Enable/disable automatic brightness */
  displayAutoBright(onFlag: boolean): boolean;
  /** Enable/disable display auto-rotation */
  displayAutoRotate(onFlag: boolean): boolean;
  /** Keep the device on while powered */
  stayOn(mode: StayOnMode): boolean;
  /** Turn off the display and activate the keyguard */
  systemLock(): boolean;
  /** Expand or collapse the system status bar */
  statusBar(expanded: boolean): boolean;
  /** Open an Android settings screen */
  settings(screenName: SettingsScreen): boolean;

  // --- Connectivity ------------------------------------------------------
  /** Enable/disable Wi-Fi */
  setWifi(setOn: boolean): boolean;
  /** Enable/disable Bluetooth */
  setBT(setOn: boolean): boolean;
  /** Set the Bluetooth adapter name */
  setBTID(toSet: string): boolean;
  /** Enable/disable airplane mode */
  setAirplaneMode(setOn: boolean): boolean;
  /** Set which radios airplane mode disables (comma-separated) */
  setAirplaneRadios(disableRadios: string): boolean;
  /** Enable/disable the mobile data setting */
  mobileData(set: boolean): boolean;
  /** Enable/disable global auto-sync */
  setAutoSync(setOn: boolean): boolean;
  /** Enable/disable Wi-Fi tethering */
  wifiTether(set: boolean): boolean;
  /** Enable/disable USB tethering */
  usbTether(set: boolean): void;

  // --- Location ----------------------------------------------------------
  /** Start a location fix; results land in %LOC / %LOCN globals */
  getLocation(source: LocationSource, keepTracking?: boolean, timeoutSecs?: number): boolean;
  /** Stop tracking started by getLocation() */
  stopLocation(): boolean;

  // --- Voice & sensors ---------------------------------------------------
  /** Capture voice input as text candidates */
  getVoice(prompt: string, languageModel: LanguageModel, timeout: number): ReadonlyArray<string>;
  /** Mute/unmute the microphone */
  micMute(shouldMute: boolean): boolean;

  // --- Feedback ----------------------------------------------------------
  /** Vibrate for the given duration */
  vibrate(durationMilliseconds: number): void;
  /** Vibrate with an off,on,off,on... millisecond pattern e.g. "500,1000,750" */
  vibratePattern(pattern: string): void;
  /** Enable/disable haptic feedback */
  haptics(onFlag: boolean): boolean;
  /** Enable/disable the notification pulse light */
  pulse(onFlag: boolean): boolean;
  /** Enable/disable UI sound effects */
  soundEffects(setTo: boolean): boolean;

  // --- Sound modes -------------------------------------------------------
  /** Set the ringer mode */
  silentMode(mode: SilentMode): boolean;
  /** Enable/disable night mode */
  nightMode(onFlag: boolean): boolean;
  /** Enable/disable car mode */
  carMode(onFlag: boolean): boolean;
  /** Enable/disable the speakerphone */
  speakerphone(setFlag: boolean): boolean;

  // --- System control ----------------------------------------------------
  /** Reboot the device (root required) */
  reboot(type?: RebootType): boolean;
  /** Power off the device (root required) */
  shutdown(): boolean;
  /** Show a numeric lock screen; blocks until unlocked or cancelled */
  lock(
    title: string,
    code: string,
    allowCancel: boolean,
    rememberCode: boolean,
    fullScreen: boolean,
    background?: string,
    layout?: string
  ): boolean;

  // --- Tasks & profiles --------------------------------------------------
  /** Run a Tasker task by name (asynchronous) */
  performTask(
    taskName: string,
    priority?: number,
    parameterOne?: string,
    parameterTwo?: string,
    returnVariable?: string,
    stop?: boolean,
    variablePassthrough?: boolean,
    variablePassthroughList?: string,
    resetReturnVariable?: boolean
  ): boolean;
  /** Whether the named task is currently running */
  taskRunning(taskName: string): boolean;
  /** Enable/disable a profile */
  enableProfile(name: string, enable: boolean): boolean;
  /** Whether the named profile is active */
  profileActive(profileName: string): boolean;

  // --- Apps & intents ----------------------------------------------------
  /** Launch an app by package name or label */
  loadApp(name: string, data?: string, excludeFromRecents?: boolean): boolean;
  /** Open a URL in the default browser */
  browseURL(URL: string): boolean;
  /** Send an Android intent */
  sendIntent(
    action: string,
    targetComp: IntentTarget,
    pkg?: string,
    cls?: string,
    category?: string,
    data?: string,
    mimeType?: string,
    extras?: ReadonlyArray<string>
  ): boolean;

  // --- Hardware input simulation (root required) -------------------------
  /** Simulate a hardware button press */
  button(name: ButtonName): boolean;
  /** Simulate D-pad movement */
  dpad(direction: DpadDirection, noRepeats?: number): boolean;
  /** Simulate keyboard typing */
  type(text: string, repeatCount?: number): boolean;

  // --- Utilities ---------------------------------------------------------
  /** Convert a value between formats */
  convert(val: string, conversionType: ConversionType): string;
  /** Set the system clipboard */
  setClip(text: string, appendFlag?: boolean): boolean;
  /** Force a media scan of the given path */
  scanCard(path?: string): boolean;
  /** Create an alarm in the default alarm app */
  setAlarm(hour: number, min: number, message?: string, confirmFlag?: boolean): boolean;
  /** Run a shell command; output capped around 750KB */
  shell(command: string, asRoot?: boolean, timeoutSecs?: number): string;
  /** Run an SL4A script */
  sl4a(scriptName: string, inTerminal?: boolean): boolean;

  // --- Flow control ------------------------------------------------------
  /** Stop the JavaScript(let) immediately */
  exit(): void;
  /** Pause execution. Prefer Effect.sleep off-device */
  wait(durationMilliseconds: number): void;
}

/** All raw Tasker function names. Kept in sync with TaskerRawApi below. */
export const TASKER_FUNCTION_NAMES = [
  "global", "setGlobal", "local", "setLocal",
  "flash", "flashLong", "popup", "showScene", "hideScene", "createScene", "destroyScene", "goHome",
  "elemText", "elemTextColour", "elemTextSize", "elemBackColour", "elemBorder", "elemPosition", "elemVisibility",
  "alarmVol", "systemVol", "mediaVol", "ringerVol", "notificationVol", "callVol", "dtmfVol", "btVoiceVol",
  "audioRecord", "audioRecordStop", "musicPlay", "musicStop", "musicSkip", "musicBack", "mediaControl", "say",
  "call", "endCall", "takeCall", "callBlock", "callDivert", "callRevert",
  "sendSMS", "composeSMS", "composeMMS", "composeEmail",
  "readFile", "writeFile", "deleteFile", "createDir", "deleteDir", "listFiles", "zip", "unzip",
  "encryptFile", "decryptFile", "encryptDir", "decryptDir", "setKey", "clearKey", "enterKey",
  "loadImage", "saveImage", "resizeImage", "rotateImage", "flipImage", "cropImage", "filterImage",
  "takePhoto", "setWallpaper",
  "displayTimeout", "displayAutoBright", "displayAutoRotate", "stayOn", "systemLock", "statusBar", "settings",
  "setWifi", "setBT", "setBTID", "setAirplaneMode", "setAirplaneRadios", "mobileData", "setAutoSync",
  "wifiTether", "usbTether",
  "getLocation", "stopLocation",
  "getVoice", "micMute",
  "vibrate", "vibratePattern", "haptics", "pulse", "soundEffects",
  "silentMode", "nightMode", "carMode", "speakerphone",
  "reboot", "shutdown", "lock",
  "performTask", "taskRunning", "enableProfile", "profileActive",
  "loadApp", "browseURL", "sendIntent",
  "button", "dpad", "type",
  "convert", "setClip", "scanCard", "setAlarm", "shell", "sl4a",
  "exit", "wait",
] as const satisfies ReadonlyArray<keyof TaskerRawApi>;

// Compile-time exhaustiveness check: the list above must cover every key.
type MissingFromNameList = Exclude<keyof TaskerRawApi, (typeof TASKER_FUNCTION_NAMES)[number]>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertAllNamesListed: MissingFromNameList extends never ? true : never = true;

// =============================================================================
// Effect-wrapped API
// =============================================================================

type AnyRawFn = (...args: never[]) => unknown;

type Effectified<F extends AnyRawFn> = (
  ...args: Parameters<F>
) => Effect.Effect<ReturnType<F>, TaskerApiError>;

/** The Tasker API with every function returning an Effect */
export type TaskerApi = {
  readonly [K in keyof TaskerRawApi]: Effectified<TaskerRawApi[K]>;
};

/** Shape of the Tasker service: the wrapped API plus environment helpers */
export interface TaskerShape extends TaskerApi {
  /** True when running inside Tasker's JavaScript environment */
  readonly isAvailable: Effect.Effect<boolean>;
}

const lookupRaw = (name: string): AnyRawFn | undefined => {
  const candidate = (globalThis as Record<string, unknown>)[name];
  return typeof candidate === "function" ? (candidate as AnyRawFn) : undefined;
};

const liveFn = <K extends keyof TaskerRawApi>(name: K): TaskerApi[K] =>
  ((...args: ReadonlyArray<unknown>) =>
    Effect.suspend((): Effect.Effect<unknown, TaskerApiError> => {
      const raw = lookupRaw(name);
      if (raw === undefined) {
        return Effect.fail(
          new TaskerNotAvailableError({
            function: name,
            message: `Tasker builtin "${name}" is not defined in this JavaScript environment`,
          })
        );
      }
      return Effect.try({
        try: () => raw(...(args as never[])),
        catch: (cause) =>
          new TaskerCallError({ function: name, message: String(cause) }),
      });
    })) as TaskerApi[K];

const makeLiveApi = (): TaskerApi =>
  Object.fromEntries(
    TASKER_FUNCTION_NAMES.map((name) => [name, liveFn(name)])
  ) as unknown as TaskerApi;

/**
 * Tasker service. The default layer binds to the real Tasker globals at call
 * time, so it is safe to construct anywhere; calls fail with
 * TaskerNotAvailableError when the builtins are missing.
 *
 * Usage:
 * ```typescript
 * const program = Effect.gen(function* () {
 *   const tasker = yield* Tasker;
 *   yield* tasker.flash("Hello from Effect!");
 * });
 * ```
 */
export class Tasker extends Effect.Service<Tasker>()("Tasker", {
  sync: (): TaskerShape => ({
    ...makeLiveApi(),
    isAvailable: Effect.sync(() => lookupRaw("flash") !== undefined),
  }),
}) {}

// =============================================================================
// Test implementation
// =============================================================================

/** A call recorded by the test Tasker implementation */
export interface RecordedCall {
  readonly name: keyof TaskerRawApi;
  readonly args: ReadonlyArray<unknown>;
}

const STRING_RESULT_FNS = new Set<keyof TaskerRawApi>([
  "global", "local", "readFile", "listFiles", "convert", "shell",
]);

const VOID_RESULT_FNS = new Set<keyof TaskerRawApi>([
  "setGlobal", "setLocal", "flash", "flashLong", "goHome",
  "vibrate", "vibratePattern", "usbTether", "exit", "wait",
]);

const testDefault = (name: keyof TaskerRawApi): unknown => {
  if (VOID_RESULT_FNS.has(name)) return undefined;
  if (STRING_RESULT_FNS.has(name)) return "";
  if (name === "getVoice") return [];
  return true;
};

/**
 * Build a test Tasker implementation that records every call and returns
 * harmless defaults (true / "" / void), with optional per-function overrides.
 */
export const makeTestTasker = (
  overrides: Partial<TaskerApi> & { readonly isAvailable?: Effect.Effect<boolean> } = {}
): { readonly api: TaskerShape; readonly calls: ReadonlyArray<RecordedCall> } => {
  const calls: Array<RecordedCall> = [];
  const api = Object.fromEntries(
    TASKER_FUNCTION_NAMES.map((name) => [
      name,
      (...args: ReadonlyArray<unknown>) =>
        Effect.suspend(() => {
          calls.push({ name, args });
          const override = overrides[name];
          if (override !== undefined) {
            return (override as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown, TaskerApiError>)(
              ...args
            );
          }
          return Effect.succeed(testDefault(name));
        }),
    ])
  ) as unknown as TaskerApi;
  return {
    api: { ...api, isAvailable: overrides.isAvailable ?? Effect.succeed(false) },
    calls,
  };
};

/** Layer with harmless defaults for tests and off-device development */
export const TaskerTest: Layer.Layer<Tasker> = Layer.sync(Tasker, () =>
  new Tasker(makeTestTasker().api)
);

/** Layer with call recording and overrides for assertions in tests */
export const makeTaskerTestLayer = (
  overrides: Partial<TaskerApi> & { readonly isAvailable?: Effect.Effect<boolean> } = {}
): { readonly layer: Layer.Layer<Tasker>; readonly calls: ReadonlyArray<RecordedCall> } => {
  const { api, calls } = makeTestTasker(overrides);
  return { layer: Layer.succeed(Tasker, new Tasker(api)), calls };
};

// =============================================================================
// Raw escape hatch
// =============================================================================

/**
 * Direct, non-Effect access to the Tasker globals with full typing. Throws
 * TaskerNotAvailableError when a builtin is missing. Intended for tiny
 * scripts where pulling in the Effect runtime is not worth it.
 */
export const raw: TaskerRawApi = new Proxy({} as TaskerRawApi, {
  get: (_target, prop: string) =>
    (...args: ReadonlyArray<unknown>) => {
      const fn = lookupRaw(prop);
      if (fn === undefined) {
        throw new TaskerNotAvailableError({
          function: prop,
          message: `Tasker builtin "${prop}" is not defined in this JavaScript environment`,
        });
      }
      return fn(...(args as never[]));
    },
});
