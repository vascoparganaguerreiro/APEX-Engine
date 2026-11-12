"use client";
// The signed-in account's Ask APEX consent (lib/strength/askConsentStore.ts), for pages other than the Ask APEX sheet.
// Same store, same key per account: a choice made here or in Ask APEX applies to both. `ready` is false while auth or this account's
// consent is loading; `owner` is the account the consent was loaded for (null until ready) and is what requests must send.
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/useAuth";
import { validUid, type ConsentStorage } from "@/lib/coach/consentStore";
import { EMPTY_ASK_STATE, askConsentView, loadAskConsent, saveAskConsent, type AskConsent, type AskConsentState } from "@/lib/strength/askConsentStore";

const storage = (): ConsentStorage | null => { try { return window.localStorage; } catch { return null; } };

export function useAskConsent(): { consent: AskConsent; ready: boolean; owner: string | null; set: (c: AskConsent) => void } {
  const { session, loading } = useAuth();
  const uid = loading ? null : validUid(session?.user?.id);
  const [state, setState] = useState<AskConsentState>(EMPTY_ASK_STATE);
  useEffect(() => { setState(loadAskConsent(storage(), uid)); }, [uid]);
  const view = askConsentView(state, uid);
  return { ...view, set: (c) => { const s = saveAskConsent(storage(), state, uid, c); if (s) setState(s); } };
}
