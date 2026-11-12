# Strength Hub, Ask APEX and Garmin export: technical notes

## Architecture

| Layer | Files | Notes |
|---|---|---|
| Vocabulary | `lib/strength/types.ts` | Muscles, equipment, patterns, set types, load modes. Mirrored by CHECK constraints in `13_strength.sql`. |
| Exercise library | `lib/strength/catalog/*`, `lib/strength/library.ts` | 165 bundled exercises, all original text. The catalog lives in code, so it works offline and loads instantly. Custom exercises go in `strength_custom_exercises`. |
| Workout model | `lib/strength/workout.ts` | Pure, immutable reducer. The live UI, finished-workout edits and confirmed Ask APEX actions all use it. |
| Offline sync | `lib/strength/sync.ts`, `idb.ts`, `runtime.ts`, `data.ts` | IndexedDB first, then upload through the `apply_strength_ops` RPC. |
| Analytics | `lib/strength/analytics.ts` | e1RM (Epley, 1 to 10 reps), PRs, progression, muscle sets, dashboard. |
| Hevy import | `lib/strength/hevy.ts` | CSV parser, format detection, preview and idempotent payload. |
| Duplicates | `lib/strength/dedup.ts` | Overlap-based matching, merged view, count-once helpers. |
| Export | `lib/strength/garmin/*` | Structured workouts, FIT encoder (experimental), ICS, JSON, Garmin Connect placeholder. |
| Ask APEX | `lib/strength/actions.ts`, `voice.ts`, `lib/coach/strength.ts`, `lib/coach/engine.ts` (`runGym`) | Same `/api/coach` route, consent, limiter (`consume_coach_quota`, kind `chat`), Gemini wrapper and storage as the Coach. Uses `domain: "strength"`. |

### Offline reliability

Every change is written to IndexedDB before any network call; localStorage is the fallback, memory the last resort. Sessions, exercises and sets have device-generated UUIDs. Each write carries a strictly increasing `rev`.

The server (`apply_strength_ops`) only accepts a newer `rev`. It answers `stale` for replays, so a response lost after the server committed can never create a duplicate set.

Deletions are tombstones (`deleted_at`). A delayed older write therefore cannot resurrect a deleted set.

Pending ops for the same row are coalesced; ops already in flight are never rewritten. Flushes are serialised per tab. Two tabs or two devices are safe because the server is idempotent; on a real conflict the newer edit wins and the older is counted as "stale".

Each op runs in its own sub-transaction. A rejected op is retried up to 5 times and then parked as "failed" and shown to the user; it never blocks the rest.

## Migration 13 (`13_strength.sql`)

Additive and idempotent. It references only the base schema (`auth.users`, `public.activities`) and pgcrypto, so it does not depend on 09–12.

Before applying, confirm that `activities.id` is an integer (the check query is in the file). Planned order stays 09 → 10 → 11 → 12 → 13.

Until 12 is applied, Ask APEX returns 503 (the Coach limiter is missing), while logging keeps working.

Until 13 is applied:
- Workouts are kept on the device and the sync status says "Saved on device only".
- Routines, history, analytics, import and duplicates show a setup notice.
- Today, the Timeline and the Coach behave exactly as before.

## Garmin Forerunner 965: what is and is not possible

Findings as of November 2026. Re-check before building on them.

- **Garmin Connect Training API** publishes workouts to the Garmin Connect calendar, and the watch picks them up on its next sync. It requires an approved Garmin Connect Developer Program (business) application and user OAuth consent. 2026 reports say new applications were paused and that personal keys are pull-only. APEX therefore only has an adapter placeholder (`GARMIN_CONNECT_ADAPTER`, status `requires_approval`) that never claims to send anything.
- **FIT workout files**: Garmin Connect's web importer does not accept workout `.fit` files. Garmin devices read workout files copied over USB into `GARMIN/NewFiles`. The FR965 is an MTP device: on Windows use Explorer; on a Mac use an MTP tool.
  - The APEX encoder (file_id, workout and workout_step messages, CRC-checked, round-trip tested) is **experimental until one file has been confirmed on the watch**.
  - Strength steps carry the FIT exercise category, step name, reps, rest and (for total loads) a target weight. Per-hand dumbbell targets are written only in the step notes.
- **Completed workouts**: watch data reaches APEX through Intervals.icu. From migration 13 on, sync also stores the origin (e.g. `GARMIN_CONNECT`, `STRAVA`), device name, elapsed time, max HR and calories when Intervals.icu provides them. **Training Effect** is not provided by this path and is not stored. Garmin activities are never modified or deleted; duplicates are linked in APEX only.
- **Calendar**: `.ics` export works with Google, Samsung and Apple calendars by file import. Live Google Calendar sync would need Google OAuth, which is a separate task.

Sources: [Garmin Training API](https://developer.garmin.com/gc-developer-program/enterprise/training-api/), [Garmin developer program overview](https://developer.garmin.com/gc-developer-program/overview), [the5krunner: developer API paused (Sep 2026)](https://the5krunner.com/2026/09/14/garmin-developer-api-access-paused/), [the5krunner: personal API (Oct 2026)](https://the5krunner.com/2026/10/22/garmin-personal-api/), [80/20 Endurance: loading FIT files](https://www.8020endurance.com/how-to-load-a-fit-file-on-your-garmin-device/), [Garmin forum: importing workouts](https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-web/390954/how-can-i-import-future-workouts/1857519).

## Hevy CSV

The parser detects columns by name: `title`, `start_time`, `end_time`, `description`, `exercise_title`, `superset_id`, `exercise_notes`, `set_index`, `set_type`, `weight_kg|weight_lbs`, `reps`, `distance_km|distance_miles|distance_meters`, `duration_seconds`, `rpe`. Missing optional columns are reported, never assumed.

This follows the commonly documented Hevy export layout. **It has not yet been verified against a real export from this account.** Check the preview on the first import.

The file does not say whether dumbbell weights are per hand or combined, so the user chooses. Repeat imports are no-ops through `source_ref = hevy|<start_time as written>|<title>`.

## Known limitations

- No demonstration images are bundled. Only original or properly licensed media may be added.
- Ask APEX does not resolve custom exercises when proposing substitutions; only library exercises can be proposed.
- Ask APEX history covers the last 365 days.
- Analytics read finished workouts from the server. Workouts still waiting to upload appear only after they sync.
- Voice uses the browser's Web Speech API, so audio goes to Google (Chrome) or Apple (Safari) for transcription. APEX stores no audio. On iOS, Safari's recognition needs Siri/Dictation enabled; Firefox has no recognition, so the text fallback is used.
- Rest-timer notifications in a background tab depend on browser and OS. iOS only allows web notifications for installed web apps.

## Browser QA checklist (not yet done)

1. Chrome (Android and desktop) and Safari (iOS): start a workout, log sets, refresh mid-workout, close and reopen the browser, and confirm nothing is lost.
2. Airplane mode: log 10 or more sets, finish, reconnect. Each set should appear once in Supabase (`select count(*) from strength_sets where session_id = …`).
3. Two tabs open on the same workout: edit in both, and check that sync converges with no duplicates.
4. Rest timer: background tab, screen locked, vibration and sound, then the +15/−15, pause and reset buttons.
5. Push-to-talk on Chrome and iOS Safari: deny and then allow microphone permission; check that "8 reps at 80 kilos" shows a proposal and nothing is applied without Confirm.
6. Ask APEX with and without the Strength consent box; with migration 12 missing (expect 503) and applied.
7. Hevy import with a real export: preview, mapping, import, then import again (expect 0 new).
8. Duplicates: a Garmin strength activity and the matching Hevy workout. Merge with each primary, check the Timeline shows one entry, unmerge, keep separate, then "Ask me again".
9. Export a routine `.fit` to a Forerunner 965 over USB and check Training → Workouts. Record the result in this file.
10. Mobile layout at 360 px width: touch targets, sticky header, rest bar and Ask APEX button must not overlap the inputs.
