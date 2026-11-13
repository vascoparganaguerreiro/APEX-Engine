"use client";
import { EXPERIENCES, EXPERIENCE_INFO } from "@/lib/experience";
import { LENS_LABEL, lensFromGoal } from "@/lib/today/lens";
import { useExperience } from "@/lib/useExperience";

/** Choose how Today is arranged: Performance, Health & Wellness or Longevity, or "Automatic" (follow the primary goal, else Performance). Saved as soon as it
 *  changes, for this account in this browser (lib/experience.ts). It only changes the ORDER of what Today shows: nothing is hidden or recalculated. */
export default function ExperiencePicker({ goal }: { goal: string | null }) {
  const { choice, ready, setChoice } = useExperience();
  const auto = lensFromGoal(goal);
  const value = choice ?? "auto";
  const pick = (v: string) => setChoice(v === "auto" ? null : (v as (typeof EXPERIENCES)[number]));
  return (
    <section id="profile-experience" className="card psec" aria-labelledby="profile-experience-h">
      <h2 id="profile-experience-h">Experience</h2>
      <p className="muted small" style={{ marginTop: 0 }}>Choose what Today puts first. Every module stays available on Today and in the menu; only the order changes. Saved for this account in this browser.</p>
      <fieldset className="exp-set" disabled={!ready}>
        <legend className="sr-only">Experience</legend>
        {EXPERIENCES.map((e) => (
          <label key={e} className={`exp-opt${value === e ? " on" : ""}`}>
            <input type="radio" name="experience" value={e} checked={value === e} onChange={() => pick(e)} />
            <span><b>{EXPERIENCE_INFO[e].label}</b><span className="muted small">{EXPERIENCE_INFO[e].short}</span><span className="muted small">{EXPERIENCE_INFO[e].focus}</span></span>
          </label>
        ))}
        <label className={`exp-opt${value === "auto" ? " on" : ""}`}>
          <input type="radio" name="experience" value="auto" checked={value === "auto"} onChange={() => pick("auto")} />
          <span><b>Automatic</b><span className="muted small">{auto.basis === "goal" ? `Follows your primary goal: ${LENS_LABEL[auto.lens]}.` : "No goal set, so Today uses Performance."}</span></span>
        </label>
      </fieldset>
    </section>
  );
}
