/**
 * Morning briefing: speak the current weather and battery status.
 *
 * Effect-based script bundled to a single JS file for Tasker: `bun run
 * compile` produces dist-tasker/morning-briefing.js. In Tasker, create a
 * task with a JavaScript action pointing at the bundled file, disable Auto
 * Exit (the script calls exit() itself when done), and attach it to a Time
 * profile (e.g. 07:00).
 *
 * Home coordinates are read through the Tasker config provider: %HOME_LAT /
 * %HOME_LON are prompted for once via TE Config when unset (falling back to
 * Madrid if the prompt goes unanswered). Current conditions are fetched from
 * open-meteo, the battery level from Tasker's built-in %BATT. The full
 * briefing text is spoken, flashed as a one-liner, and stored in %BRIEFING.
 */

import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
} from "@effect/platform";
import { Config, Effect, Layer, Schema } from "effect";
import { Tasker } from "../../src/tasker-api.js";
import { taskerConfigLayer } from "../../src/config.js";
import { runInTasker } from "../../src/runtime.js";

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
    const forecast = yield* client
      .get(url)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ForecastResponse)));
    return forecast.current_weather;
  }
);

const program = Effect.gen(function* () {
  const tasker = yield* Tasker;
  const lat = yield* Config.string("HOME_LAT").pipe(Config.withDefault("40.41"));
  const lon = yield* Config.string("HOME_LON").pipe(Config.withDefault("-3.70"));

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

void runInTasker(
  program.pipe(
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, taskerConfigLayer()))
  ),
  { exitWhenDone: true }
);
