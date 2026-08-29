/**
 * Adaptive night mode: drive the "Night Mode" profile's window with the sun.
 *
 * Effect-based script bundled to a single JS file for Tasker: `bun run
 * compile` produces dist-tasker/adaptive-night-mode.js. In Tasker, create a
 * task with a JavaScript action pointing at the bundled file, disable Auto
 * Exit (the script calls exit() itself when done), and run it from a
 * periodic Time profile (e.g. every 30 minutes). It pairs with the DSL
 * "Night Mode" profile (tasks/popular/quiet.ts), which is gated by a
 * variable trigger on %NIGHT_WINDOW rather than a fixed Time context —
 * `enableProfile` cannot move a Time-context window, so this script owns
 * the window by flipping that global instead.
 *
 * Home coordinates are read through the Tasker config provider: %HOME_LAT /
 * %HOME_LON are prompted for once via TE Config when unset (falling back to
 * Madrid if the prompt goes unanswered). Sunrise/sunset come from open-meteo
 * (in the location's own timezone, not the device's) and are mirrored into
 * %NIGHT_START (sunset) and %NIGHT_END (sunrise) as HH:MM; %NIGHT_WINDOW is
 * set to "1" after sunset or before sunrise, "0" otherwise.
 */

import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
} from "@effect/platform";
import { Config, DateTime, Effect, Layer, Schema } from "effect";
import { Tasker } from "../../src/tasker-api.js";
import { taskerConfigLayer } from "../../src/config.js";
import { runInTasker } from "../../src/runtime.js";

/** A local ISO datetime as open-meteo renders it, e.g. "2026-08-18T07:12". */
const LocalIsoTime = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/, {
    identifier: "LocalIsoTime",
  })
);

const SunResponse = Schema.Struct({
  timezone: Schema.String,
  daily: Schema.Struct({
    sunrise: Schema.NonEmptyArray(LocalIsoTime),
    sunset: Schema.NonEmptyArray(LocalIsoTime),
  }),
});

/** "2026-08-18T07:12" (open-meteo local ISO datetime) → "07:12" */
const hhmm = (isoLocal: string): string => isoLocal.slice(11, 16);

const minutesOfDay = (time: string): number =>
  Number.parseInt(time.slice(0, 2), 10) * 60 +
  Number.parseInt(time.slice(3, 5), 10);

const fetchSunTimes = Effect.fn("adaptiveNightMode.fetchSunTimes")(
  function* (lat: string, lon: string) {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk
    );
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=sunrise,sunset&timezone=auto`;
    const response = yield* client
      .get(url)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(SunResponse)));
    return { daily: response.daily, timezone: response.timezone };
  }
);

const program = Effect.gen(function* () {
  const tasker = yield* Tasker;
  const lat = yield* Config.string("HOME_LAT").pipe(Config.withDefault("40.41"));
  const lon = yield* Config.string("HOME_LON").pipe(Config.withDefault("-3.70"));

  yield* fetchSunTimes(lat, lon).pipe(
    Effect.flatMap(({ daily, timezone }) =>
      Effect.gen(function* () {
        const nightStart = hhmm(daily.sunset[0]);
        const nightEnd = hhmm(daily.sunrise[0]);
        yield* tasker.setGlobal("NIGHT_START", nightStart);
        yield* tasker.setGlobal("NIGHT_END", nightEnd);

        const now = yield* DateTime.nowInCurrentZone.pipe(
          DateTime.withCurrentZoneNamed(timezone),
          Effect.orElse(() =>
            DateTime.nowInCurrentZone.pipe(DateTime.withCurrentZoneLocal)
          )
        );
        const nowMinutes =
          DateTime.getPart(now, "hours") * 60 + DateTime.getPart(now, "minutes");
        const isNight =
          nowMinutes >= minutesOfDay(nightStart) ||
          nowMinutes < minutesOfDay(nightEnd);

        const previous = yield* tasker
          .global("NIGHT_WINDOW")
          .pipe(Effect.orElseSucceed(() => undefined));
        yield* tasker.setGlobal("NIGHT_WINDOW", isNight ? "1" : "0");

        if (previous !== (isNight ? "1" : "0")) {
          yield* tasker.flash(
            `Night Mode ${isNight ? "enabled" : "disabled"} (night ${nightStart}–${nightEnd})`
          );
        }
      })
    ),
    Effect.catchTags({
      RequestError: (error) =>
        tasker.flash(`Night mode: sun times request failed (${error.message})`),
      ResponseError: (error) =>
        tasker.flash(
          error.reason === "StatusCode"
            ? `Night mode: weather service returned ${error.response.status}`
            : `Night mode: sun times response failed (${error.message})`
        ),
      ParseError: () =>
        tasker.flash("Night mode: unexpected open-meteo payload"),
    })
  );
});

void runInTasker(
  program.pipe(
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, taskerConfigLayer()))
  ),
  { exitWhenDone: true }
);
