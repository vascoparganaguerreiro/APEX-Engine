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
- Ask APEX history covers the last 365 days (up to 300 sessions containing the exercises in question).
- Analytics read all finished workouts from the server (paged, up to 5,000). Workouts still waiting to upload appear only after they sync.
- A Hevy workout that was imported and then deleted in APEX is not imported again from the same file (its fingerprint is kept); the preview says so.
- Voice uses the browser's Web Speech API, so audio goes to Google (Chrome) or Apple (Safari) for transcription. APEX stores no audio. On iOS, Safari's recognition needs Siri/Dictation enabled; Firefox has no recognition, so the text fallback is used.
- Rest-timer notifications in a background tab depend on browser and OS. iOS only allows web notifications for installed web apps.

## Applying the pending migrations (staging only)

Order: **09 → 10 → 11 → 12 → 13**. None of them depends on another at the SQL level (09: auth.users; 10: races; 11: profiles; 12: auth.users; 13: auth.users + activities), so a failure in one never breaks the next. The order matches the app's features: biomarker limiter, Race Hub, Profile, Coach (needed by Ask APEX), Strength Hub.

For each file: paste it into the SQL Editor wrapped in `begin;` … `commit;`, so an error leaves nothing half-applied. Then run its verification queries (at the end of each file). Before 13, also run:

```sql
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'activities' order by ordinal_position;
```

`id` must be an integer type, and `user_id` must be a uuid. If `origin`, `origin_device`, `elapsed_s`, `max_hr` or `calories` already exist with another meaning or type, stop and review: 13 would skip adding them and the sync would write into them.

## Exact browser QA sequence (not yet done)

Run the app locally (`npm run dev`) against the staging Supabase project, signed in with a staging test account.

**Stage A: before applying anything (missing-migration behaviour)**
1. Open Today, Activities, Timeline, Coach and Profile. Each must load without errors. Profile → Wearable device says migration 13 is needed.
2. Strength: start an empty workout, add Bench Press, enter 60 × 10, tap ✓. The sync pill must say "Saved on device only". Refresh the page: the set must still be there.
3. Finish the workout. The summary opens from the device copy. Routines, Progress, Import and Duplicates must show the setup notice, not an error.

**Stage B: apply 09, 10, 11, 12**
4. Biomarkers → upload a report: it is read, not answered with 503 (limiter present).
5. Races and Profile: save a race and a baseline.
6. Coach → chat works. Its consent list has no "Strength training" switch.
7. Strength (live workout) → Ask APEX without ticking "Share this workout": the answer is general guidance. Tick it and ask "Should I add weight?": the answer refers to your sets.

**Stage C: apply 13, then refresh the app**
8. The workout from step 2 uploads by itself: the pill shows "Saved". Supabase: `select count(*) from strength_sets where session_id = '<id>'` returns exactly the number of sets.
9. Run an Intervals.icu sync. Then `select origin, origin_device from activities order by started_at desc limit 5` is filled for new rows; older rows are unchanged.
10. **Offline:** start a workout, turn on airplane mode, log 10 or more sets (including one deleted and one edited), finish, close the browser. Reopen, turn the network back on, and wait for "Saved". Supabase shows each set once, with no deleted set.
11. **Lost connection mid-upload:** in DevTools set the network to Offline while the pill says "Saving…", then back online. Still no duplicates.
12. **Two tabs:** open the same finished workout in two tabs, change different sets in each, reload both: both changes are present.
13. Rest timer: complete a set, lock the phone, and check vibration and sound at 0. Check +15, −15, pause, reset and skip.
14. Superset two exercises: there is no rest between A and B, and rest comes after B.
15. Push-to-talk (Chrome Android, iOS Safari): first deny the microphone (a helpful message must appear), then allow it. Say "8 reps at 80 kilos, add that set": a proposal appears and nothing changes until you tap Confirm. Changing a completed set asks again.
16. Say or type "I felt a sharp pain in my shoulder": the stop and medical-assessment reply appears, with no AI call.
17. Routines: create one from the Push template, reorder it, add a substitute, save, duplicate it, delete the copy, then Start workout from it.
18. Hevy: import a real export. Check the column detection, units, the dumbbell choice and the unmatched names. Import, then import the same file again: everything shows "already imported" and 0 are imported. Delete one imported workout and import again: it shows "imported before, then deleted" and is not re-added.
19. Duplicates: with a Garmin strength activity and the matching Hevy workout, merge with Garmin as primary. The Timeline shows one entry; Today's and the Activities page's load for that day are unchanged. Undo the merge: two entries come back and both originals are intact. Keep separate, then "Ask me again".
20. Garmin + Strava copy of the same activity: after merging, Today's daily load and the weekly AI summary count it once.
21. Progress: the totals match `select count(*) from strength_sessions where deleted_at is null and status = 'completed'`, including after a large Hevy import.
22. Export: download a routine `.fit`, copy it to the Forerunner 965 (`GARMIN/NewFiles` over USB), and check Training → Workouts on the watch. Record the result here. Until then it stays "experimental". Also import the `.ics` into Google Calendar.
23. Mobile at 360 px width: touch targets, sticky header, the rest bar and the Ask APEX button must not cover the inputs.
