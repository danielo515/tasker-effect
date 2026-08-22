/**
 * Adaptive night mode: toggle the "Night Mode" profile with the sun.
 *
 * Effect-based script bundled to a single JS file for Tasker: `bun run
 * compile` produces dist-tasker/adaptive-night-mode.js. In Tasker, create a
 * task with a JavaScript action pointing at the bundled file, disable Auto
 * Exit (the script calls exit() itself when done), and run it from a
 * periodic Time profile (e.g. every 30 minutes). It pairs with the DSL
 * "Night Mode" profile — this script only enables or disables that profile.
 *
 * Sunrise/sunset for %HOME_LAT / %HOME_LON (defaulting to Madrid) come from
 * open-meteo and are mirrored into %NIGHT_START (sunset) and %NIGHT_END
 * (sunrise) as HH:MM; "Night Mode" is enabled after sunset or before
 * sunrise, disabled otherwise.
 */

import { FetchHttpClient, HttpClient } from "@effect/platform";
import { DateTime, Effect, Schema } from "effect";
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

const SunResponse = Schema.Struct({
  daily: Schema.Struct({
    sunrise: Schema.Array(Schema.String),
    sunset: Schema.Array(Schema.String),
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
    const payload = yield* client
      .get(url)
      .pipe(Effect.flatMap((response) => response.json));
    const response = yield* Schema.decodeUnknown(SunResponse)(payload);
    return response.daily;
  }
);

const program = Effect.gen(function* () {
  const tasker = yield* Tasker;
  const lat = yield* globalOr("HOME_LAT", "40.41");
  const lon = yield* globalOr("HOME_LON", "-3.70");

  yield* fetchSunTimes(lat, lon).pipe(
    Effect.flatMap((daily) =>
      Effect.gen(function* () {
        const sunriseIso = daily.sunrise[0];
        const sunsetIso = daily.sunset[0];
        if (sunriseIso === undefined || sunsetIso === undefined) {
          yield* tasker.flash(
            "Night mode: open-meteo returned no sun times for today"
          );
          return;
        }

        const nightStart = hhmm(sunsetIso);
        const nightEnd = hhmm(sunriseIso);
        yield* tasker.setGlobal("NIGHT_START", nightStart);
        yield* tasker.setGlobal("NIGHT_END", nightEnd);

        const now = yield* DateTime.nowInCurrentZone.pipe(
          DateTime.withCurrentZoneLocal
        );
        const nowMinutes =
          DateTime.getPart(now, "hours") * 60 + DateTime.getPart(now, "minutes");
        const isNight =
          nowMinutes >= minutesOfDay(nightStart) ||
          nowMinutes < minutesOfDay(nightEnd);

        yield* tasker.enableProfile("Night Mode", isNight);
        yield* tasker.flash(
          `Night Mode ${isNight ? "enabled" : "disabled"} (night ${nightStart}–${nightEnd})`
        );
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

void runInTasker(program.pipe(Effect.provide(FetchHttpClient.layer)), {
  exitWhenDone: true,
});
