# Strength: premium mobile workout experience: implementation plan

Status: **Stages 1 to 3 and the header (listed here as Stage 5) done**: safety net and pure keypad logic; compact set table; custom keypad in live workouts; minimal header with menu. Stage 4 (drag-and-drop reordering) is done too. Stage 6 (compact rest timer and one bottom dock) is done, and the floating controls are removed from active workouts (first part of Stage 7). Final QA is not started. Each stage ends with: focused tests, the full suite, `tsc --noEmit`,
and (for UI changes) `npm run build`. No stage touches the database, the workout engine (`lib/strength/workout.ts`), `save()` / `engine.record()` or recovery.

## Ground rules
- The engine, calculations, data structures, autosave (`save()` -> `engine.record()` -> debounced `flush()`) and recovery stay exactly as they are. New code only
  changes the input layer, layout and navigation, and feeds the existing `updateSet` / `completeSet` / `moveExercise`.
- History editing (`WorkoutEditor mode="edit"`) keeps native inputs and its current layout until a later, separate decision. New behaviour is live-mode only.
- No migration. No new dependency unless a stage's spike shows it is clearly better (see Stage 4).
- Design system: existing CSS tokens (`--sp-*`, `--r-*`, `--fs-*`) and classes. Not Tailwind.
- Safe areas, landscape and scrolling: reuse `--bnav-h`, `env(safe-area-inset-*)`, the phone media query (`lib/nav.ts` PHONE_MEDIA), and one shared bottom-stack height model (Stage 6).

## Findings that shape the plan
- `package.json` has four dependencies (supabase-js, next, react, react-dom). There is **no** drag-and-drop or UI library, and no drag code anywhere.
- `moveExercise(w, id, toIndex)` already exists, is tested, keeps ids and data, and renumbers positions. Reordering needs no engine change.
- `NumField` commits every valid value on every keystroke ("82." commits 82 and keeps the text). The keypad must keep that rule exactly (`commitOf`).
- Native-keyboard focus drives `kb-open` (hides the bottom nav and floating buttons). A custom keypad has no native focus, so it needs its own `kp-open` signal.
- The same `WorkoutEditor` serves live and history edit. Anything new is gated on `mode === "live"`.
- Per-set "previous" does not exist today (only one "Last time" paragraph per exercise); `lastPerformance(history, key, ...)` already returns per-set data.

## Stage 1: safety net and pure keypad logic (DONE)
- `lib/strength/keypad.ts` (pure): `ActiveField { exerciseId, setId, field }`, edit buffer (`openField`, `press`: digits, one decimal point, backspace, clear,
  integer-only for reps and seconds, two decimals, limits mirroring `setPatchError`), the commit rule `commitOf` (identical to `NumField`), `fieldKeysFor`
  (Weight/Reps per measurement) and `nextTarget` (Weight -> Reps -> next open set's Weight -> next exercise -> end; done sets skipped).
- `tests/strength-keypad.test.ts` and `tests/strength-logger-characterization.test.ts` pin today's behaviour: number boxes, rejection, completion and prefill, autosave
  and a real reload recovery through `SyncEngine`, history edit separation, reorder data preservation, and the current header/FAB/timer baseline.
- No UI or behaviour change.

## Stage 2: compact set table and previous performance (DONE)
- Row: Set | Previous | KG | Reps | Done, one dense line per set. Previous per set from `lastPerformance` (blank when there is no history, never invented).
- RPE, RIR, set type, side, note, delete and the +/- weight steps move into one expandable section per set (reuse the existing "More" row); all stay reachable.
- Warm-up sets: distinct label ("W") and tint. Completed sets: green row background and green check, immediately on completion.
- Touch targets stay at least 44px tall (row height, not tiny type). Native inputs stay in this stage.
- Tests: markup and CSS pattern tests, previous-per-set mapping with missing history, warm-up numbering, history edit unchanged.

## Stage 3: custom keypad and active-field navigation (live mode) (DONE)
- One central `ActiveField` in the editor. Fields become button-like cells (not inputs), named "Set 2 weight, 80 kg", showing the buffer while active.
- `NumKeypad` docked at the bottom: 0-9, decimal (hidden for reps and seconds), backspace, clear, Next, and Done/close. Each key press runs `press`, then
  `commitOf`, then the existing `updateSet` through `save()`, so autosave is unchanged.
- Next uses `nextTarget`; when it returns null the keypad closes. The active row is scrolled above the dock using a measured `--kp-h`.
- Default on phones; a per-account switch ("Use the phone keyboard") keeps native inputs. Desktop and hardware keyboards: native inputs by default, and when the
  keypad is shown a hardware keyboard still works (digits, ".", Backspace, Enter = Next, Escape = close).
- Opening the keypad sets `kp-open` (hides the bottom nav and floating buttons); completing a set closes it (Stage 6 shows the rest timer).
- Accessibility: labelled keys, `aria-live` value readout, focus returns to the field, visible focus rings, 48px keys. iOS and Android are tested on real devices before
  this becomes the default (not decided from desktop emulation).

## Stage 4: exercise drag-and-drop reordering (DONE, in-house Pointer Events, no new dependency)
- Library decision: **no new dependency by default.** A small in-house Pointer Events sortable is enough for one vertical list: a pure `reorder(list, from, to)`
  built on `moveExercise`, plus a hook for press, move and release. `@dnd-kit` (core + sortable + utilities) would add three packages and a lockfile change; it is
  only chosen if a short spike shows the in-house version cannot meet the touch requirements (scroll vs drag, auto-scroll while dragging, DragOverlay-like preview).
- Interaction: long-press the exercise header (about 250 ms, 5 px movement tolerance; tuned on real devices). Before the delay a vertical swipe scrolls normally
  (`touch-action: pan-y` on the list, set to `none` only on the active drag).
- Feedback: floating preview of the dragged card, a clear drop indicator, animated shifting of the other cards, edge auto-scroll. A short haptic
  (`navigator.vibrate`) on activation only when available, wrapped so unsupported devices never fail.
- Keyboard and screen-reader alternative: the existing Move up / Move down actions, plus a "Reorder" mode (Space to pick up, arrows to move, Space to drop, Escape to
  cancel) with live announcements.
- Persistence: the drop calls `moveExercise` -> `save()`, so the new order is autosaved and recovered like any other change. Ids, sets, values, RPE and completion are
  untouched; the invariants are already pinned by the Stage 1 reorder test. Live mode first; history edit later if wanted.
- Collapse each card during a drag if needed for a short, easy-to-target list.

## Stage 5: minimal header and secondary menu (DONE: built when requested as "Stage 4")
- Sticky header: title, duration, Minimise, Finish. A single overflow menu holds Pause/Resume, Cancel workout, rest alerts and Ask APEX.
- Minimise navigates away and keeps the workout active (it already survives navigation; Today offers "Continue your workout"). A persistent mini-bar elsewhere is
  out of scope unless approved.
- The progress bar and "Now/Next" line are kept in compact form or folded into the title row; nothing is lost.

## Stage 6: compact rest timer and one bottom stack (DONE)
- Single horizontal dock: -15s, Pause/Resume, Skip, +15s, with the clock. Reset moves to the menu. Persistence (`loadRest`/`saveRest`) and past-zero overrun are untouched.
- One height model for bottom nav, rest timer and keypad (extends `--rest-h` with `--kp-h`), with page padding computed from it, so nothing overlaps and inputs are
  never covered. Completing a set closes the keypad and shows the timer.
- Landscape and short phones use the existing phone media query.

## Stage 7: remove floating buttons and final polish
- Remove the Ask APEX pill (the drawer stays reachable from the menu) and hide the global Quick actions button during an active workout.
- Accessibility pass, landscape and safe-area pass, real-phone QA (iOS Safari, Android Chrome), documentation.

## Risks and how each is contained
| Risk | Containment |
| --- | --- |
| Losing partial input ("82.") | Same commit rule as `NumField`, pinned by tests; keypad buffer is separate from the saved value |
| Autosave or recovery regression | No change to `save()`, the engine or `workout.ts`; recovery pinned by a real reload test |
| Keypad, timer or nav covering inputs | One shared bottom-stack height model, scroll-into-view with measured heights, tested per stage |
| iOS/Android keyboard quirks | Button-like fields (no `inputMode="none"` reliance); real-device check before default |
| Drag fighting scroll | Long-press activation, `touch-action` only during drag, tolerance tuned on devices, keyboard alternative |
| Data loss on reorder | Only `moveExercise`; invariants pinned (ids, sets, values, completion, positions 0..n-1) |
| History editing breaks | New behaviour gated on `mode === "live"`; history tests unchanged |
| New dependency creep | None unless the Stage 4 spike proves it is needed |

## Open decisions (to confirm before the stage that needs them)
1. Minimise: navigate away only, or also add a persistent mini-bar? (Stage 5)
2. Keypad default: on by default on phones (recommended), with a switch back to the native keyboard. (Stage 3)
3. Quick actions button: hidden for the whole active workout (recommended) or only while the keypad is open. (Stage 7)
4. Drag library: in-house Pointer Events (recommended) unless the spike says otherwise. (Stage 4)
