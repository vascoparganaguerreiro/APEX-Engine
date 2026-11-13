"use client";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/useAuth";
import { validUid } from "@/lib/coach/consentStore";
import { PHONE_MEDIA } from "@/lib/nav";
import { EMPTY_KEYPAD_PREF, keypadActive, keypadPrefView, loadKeypadPrefState, saveKeypadPrefState, type KeypadPrefState, type KeypadPrefStorage } from "./keypadPref";

const storage = (): KeypadPrefStorage | null => { try { return window.localStorage; } catch { return null; } };

/** Same breakpoint as the bottom bar: a phone layout (narrow, or a short touchscreen held sideways). False on the server and on first render. */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_MEDIA);
    const on = () => setPhone(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

/** Whether the APEX keypad is in use for this workout screen, and the switch to the phone keyboard (remembered for the signed-in account in this browser).
 *  `live` is false for history editing: it always keeps the native inputs and never reads or writes the preference. */
export function useKeypadMode(live: boolean): { custom: boolean; native: boolean; phone: boolean; setNative: (native: boolean) => void } {
  const { session, loading } = useAuth();
  const uid = live && !loading ? validUid(session?.user?.id) : null;
  const phone = usePhoneLayout();
  const [state, setState] = useState<KeypadPrefState>(EMPTY_KEYPAD_PREF);
  useEffect(() => { setState(loadKeypadPrefState(storage(), uid)); }, [uid]);
  const { native, ready } = keypadPrefView(state, uid);
  const setNative = (n: boolean) => { const s = saveKeypadPrefState(storage(), state, uid, n); if (s) setState(s); };
  return { custom: keypadActive({ live, phone, ready, native }), native, phone: live && phone, setNative };
}
