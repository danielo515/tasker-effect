import { describe, expect, it } from "@effect/vitest"
import {
  BluetoothConnectedTrigger,
  Flash,
  GetLocation,
  GoHome,
  HeadsetPluggedTrigger,
  HttpRequest,
  If,
  LaunchApp,
  MusicPlay,
  PerformTask,
  PerformTaskerTask,
  Popup,
  PowerTrigger,
  ReceivedTextTrigger,
  Say,
  SendIntent,
  SendSms,
  SetClip,
  SetDisplayTimeout,
  SetVolume,
  Shell,
  TimeOfDay,
  TimeTrigger,
  WifiConnectedTrigger,
  WriteFile,
  cond,
} from "../src/profile.js"

// These classes accept the field, but the DSL's `Action`/`Trigger` builder
// functions always pass it explicitly, so the Schema-level `default: () =>
// ...` callback is only ever exercised when the class is constructed
// directly without it (e.g. by decoding a partial/compact encoded value).
describe("Schema.optionalWith default callbacks", () => {
  it("Flash.long defaults to false", () => {
    expect(new Flash({ text: "hi" }).long).toBe(false)
  })

  it("Popup defaults showOverKeyguard/timeoutSecs", () => {
    const popup = new Popup({ title: "t", text: "x" })
    expect(popup.showOverKeyguard).toBe(false)
    expect(popup.timeoutSecs).toBe(0)
  })

  it("Say defaults stream/pitch/speed", () => {
    const say = new Say({ text: "hi" })
    expect(say.stream).toBe("media")
    expect(say.pitch).toBe(5)
    expect(say.speed).toBe(5)
  })

  it("PerformTask.priority defaults to 5", () => {
    expect(new PerformTask({ taskName: "T" }).priority).toBe(5)
  })

  it("PerformTaskerTask.priority defaults to 5", () => {
    expect(new PerformTaskerTask({ taskName: "T" }).priority).toBe(5)
  })

  it("Shell defaults asRoot/timeoutSecs", () => {
    const shell = new Shell({ command: "ls" })
    expect(shell.asRoot).toBe(false)
    expect(shell.timeoutSecs).toBe(30)
  })

  it("WriteFile.append defaults to false", () => {
    expect(new WriteFile({ path: "p", text: "t" }).append).toBe(false)
  })

  it("HttpRequest.headers defaults to {}", () => {
    expect(new HttpRequest({ method: "GET", url: "u" }).headers).toEqual({})
  })

  it("SendSms.storeInMessagingApp defaults to false", () => {
    expect(new SendSms({ number: "1", text: "hi" }).storeInMessagingApp).toBe(false)
  })

  it("SetVolume defaults display/sound", () => {
    const volume = new SetVolume({ stream: "media", level: 5 })
    expect(volume.display).toBe(false)
    expect(volume.sound).toBe(false)
  })

  it("MusicPlay defaults offsetSecs/loop/stream", () => {
    const music = new MusicPlay({ path: "p" })
    expect(music.offsetSecs).toBe(0)
    expect(music.loop).toBe(false)
    expect(music.stream).toBe("media")
  })

  it("SetClip.append defaults to false", () => {
    expect(new SetClip({ text: "x" }).append).toBe(false)
  })

  it("LaunchApp.excludeFromRecents defaults to false", () => {
    expect(new LaunchApp({ app: "a" }).excludeFromRecents).toBe(false)
  })

  it("SendIntent.extras defaults to []", () => {
    expect(
      new SendIntent({ action: "a", targetComp: "activity" }).extras
    ).toEqual([])
  })

  it("GoHome.screen defaults to 0", () => {
    expect(new GoHome({}).screen).toBe(0)
  })

  it("GetLocation defaults keepTracking/timeoutSecs", () => {
    const location = new GetLocation({ source: "gps" })
    expect(location.keepTracking).toBe(false)
    expect(location.timeoutSecs).toBe(100)
  })

  it("SetDisplayTimeout defaults hours/minutes/seconds", () => {
    const timeout = new SetDisplayTimeout({})
    expect(timeout.hours).toBe(0)
    expect(timeout.minutes).toBe(0)
    expect(timeout.seconds).toBe(0)
  })

  it("If.orElse defaults to []", () => {
    // oxlint-disable-next-line unicorn/no-thenable -- `then` here is the DSL's action-list field, not a promise
    const branch = new If({ condition: cond("%A", "eq", "1"), then: [] })
    expect(branch.orElse).toEqual([])
  })

  it("TimeTrigger.days defaults to []", () => {
    expect(new TimeTrigger({ from: new TimeOfDay({ hour: 7, minute: 0 }) }).days).toEqual([])
  })

  it("WifiConnectedTrigger.ssid defaults to *", () => {
    expect(new WifiConnectedTrigger({}).ssid).toBe("*")
  })

  it("BluetoothConnectedTrigger.name defaults to *", () => {
    expect(new BluetoothConnectedTrigger({}).name).toBe("*")
  })

  it("HeadsetPluggedTrigger.kind defaults to any", () => {
    expect(new HeadsetPluggedTrigger({}).kind).toBe("any")
  })

  it("PowerTrigger.source defaults to any", () => {
    expect(new PowerTrigger({}).source).toBe("any")
  })

  it("ReceivedTextTrigger.kind defaults to any", () => {
    expect(new ReceivedTextTrigger({}).kind).toBe("any")
  })
})
