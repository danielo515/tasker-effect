/**
 * Morning briefing: speak the current weather and battery status.
 *
 * Effect-based script bundled to a single JS file for Tasker: `bun run
 * compile` produces dist-tasker/morning-briefing.js. In Tasker, create a
 * task with a JavaScript action pointing at the bundled file, disable Auto
 * Exit (the script calls exit() itself when done), and attach it to a Time
 * profile (e.g. 07:00).
 *
 * Home coordinates come from the Tasker globals %HOME_LAT / %HOME_LON
 * (defaulting to Madrid); current conditions are fetched from open-meteo,
 * the battery level from Tasker's built-in %BATT. The full briefing text is
 * spoken, flashed as a one-liner, and stored in %BRIEFING.
 */

import { FetchHttpClient, HttpClient } from "@effect/platform";
import { Effect, Schema } from "effect";
import { Tasker } from "../../src/tasker-api.js";
import { runInTasker } from "../../src/runtime.js";

const globalOr = (name: string, fallback: string) =>
  Effect.gen(function* () {
    const tasker = yield* Tasker;
    const value = yield* tasker
      .global(name)
      .pipe(Effect.orElseSucceed(() => ""));
    return value === "" || value === undefined ? fallback : value;
  });

const ForecastResponse = Schema.Struct({
  current_weather: Schema.Struct({
    temperature: Schema.Number,
    windspeed: Schema.Number,
  }),
});

const fetchCurrentWeather = Effect.fn("morningBriefing.fetchCurrentWeather")(
  function* (lat: string, lon: string) {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk
    );
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
    const payload = yield* client
      .get(url)
      .pipe(Effect.flatMap((response) => response.json));
    const forecast = yield* Schema.decodeUnknown(ForecastResponse)(payload);
    return forecast.current_weather;
  }
);

const program = Effect.gen(function* () {
  const tasker = yield* Tasker;
  const lat = yield* globalOr("HOME_LAT", "40.41");
  const lon = yield* globalOr("HOME_LON", "-3.70");

  const battery = yield* tasker
    .global("BATT")
    .pipe(Effect.orElseSucceed(() => ""));
  const level = Number.parseInt(battery, 10);
  const batteryPart = Number.isNaN(level)
    ? "Battery level unknown."
    : `Battery at ${level} percent.`;

  yield* fetchCurrentWeather(lat, lon).pipe(
    Effect.flatMap((weather) =>
      Effect.gen(function* () {
        const text =
          `Good morning. It is ${weather.temperature} degrees with wind at ` +
          `${weather.windspeed} kilometers per hour. ${batteryPart}`;
        yield* tasker.setGlobal("BRIEFING", text);
        yield* tasker.flash(
          `${weather.temperature}°C, wind ${weather.windspeed} km/h — ${batteryPart}`
        );
        yield* tasker.say(text, undefined, undefined, "media", 5, 5);
      })
    ),
    Effect.catchTags({
      RequestError: (error) =>
        tasker.flash(`Morning briefing: weather request failed (${error.message})`),
      ResponseError: (error) =>
        tasker.flash(
          error.reason === "StatusCode"
            ? `Morning briefing: weather service returned ${error.response.status}`
            : `Morning briefing: weather response failed (${error.message})`
        ),
      ParseError: () =>
        tasker.flash("Morning briefing: unexpected open-meteo payload"),
    })
  );
});

void runInTasker(program.pipe(Effect.provide(FetchHttpClient.layer)), {
  exitWhenDone: true,
});
