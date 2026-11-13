"use client";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/useAuth";
import { validUid } from "@/lib/coach/consentStore";
import { EMPTY_EXPERIENCE_STATE, experienceView, loadExperienceState, saveExperienceState, type ExperienceState, type ExperienceStorage } from "@/lib/experience";
import type { Lens } from "@/lib/today/lens";

const storage = (): ExperienceStorage | null => { try { return window.localStorage; } catch { return null; } };

/** The signed-in account's chosen experience (lib/experience.ts), kept in this browser. `ready` is false while auth or that account's choice is loading;
 *  `choice` is null when the person has not chosen one. Sign-out or an account switch drops the previous account's choice in the same render. */
export function useExperience(): { choice: Lens | null; ready: boolean; setChoice: (l: Lens | null) => void } {
  const { session, loading } = useAuth();
  const uid = loading ? null : validUid(session?.user?.id);
  const [state, setState] = useState<ExperienceState>(EMPTY_EXPERIENCE_STATE);
  useEffect(() => { setState(loadExperienceState(storage(), uid)); }, [uid]);
  const { choice, ready } = experienceView(state, uid);
  const setChoice = (l: Lens | null) => { const s = saveExperienceState(storage(), state, uid, l); if (s) setState(s); };
  return { choice, ready, setChoice };
}
