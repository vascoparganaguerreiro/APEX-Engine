"""AI Coach helpers: build the athlete-data context and call Gemini. No Streamlit in here."""
from __future__ import annotations

import re

SYSTEM_PROMPT = """You are APEX Coach, a sports-science assistant inside the APEX Engine app, \
talking to one endurance athlete about their own data.

Rules:
- Use ONLY the ATHLETE DATA block below for facts about the athlete. If something is missing, say so instead of guessing.
- Be concise and practical: lead with the answer, then 2-4 short reasons that cite the actual numbers. Plain text, no tables unless asked.
- Give training, recovery and nutrition guidance in the normal range for healthy recreational and competitive endurance athletes. HRV and load models are estimates, so say when you are unsure.
- You are not a doctor. For pain, injury, chest symptoms, fainting, a persistently very high resting heart rate or sudden unusual changes in sleep or health, advise seeing a qualified professional. Do not diagnose or recommend medication.
- Never invent data, races or workouts.
- Reply in the language the athlete writes in."""


def _f(x, fmt="{:.0f}", dash="n/a"):
    return fmt.format(x) if x is not None else dash


def build_context(today, profile, days, sessions, load, readiness, race) -> str:
    """Compact text summary of the athlete's data (kept small on purpose)."""
    lines = [f"Today: {today.isoformat()}"]
    if profile:
        bits = []
        for key, label in (("weight_kg", "weight kg"), ("height_cm", "height cm"), ("max_hr", "max HR"),
                           ("ftp_watts", "FTP W"), ("sleep_goal_h", "sleep goal h")):
            if profile.get(key):
                bits.append(f"{label} {profile[key]}")
        if bits:
            lines.append("Profile: " + ", ".join(bits))

    if readiness:
        lines.append(f"Today's readiness: {readiness.score}/100 ({readiness.verdict}); "
                     f"HRV baseline built on {readiness.baseline_days} prior days"
                     + (f", HRV z-score {readiness.hrv_z:+.1f}" if readiness.hrv_z is not None else ""))

    lines.append("\nLast days (day: HRV, resting HR, sleep, sleep score, body battery, stress):")
    if days:
        for r in days[-14:]:
            sleep_h = r["sleep_minutes"] / 60 if r.get("sleep_minutes") else None
            lines.append(f"{r['day']}: HRV {_f(r.get('hrv_ms'))} ms, RHR {_f(r.get('rhr_bpm'))}, "
                         f"sleep {_f(sleep_h, '{:.1f}')} h, score {_f(r.get('sleep_score'))}, "
                         f"body battery {_f(r.get('body_battery'))}, stress {_f(r.get('stress_avg'))}")
    else:
        lines.append("(no daily data)")

    lines.append("\nTraining load model:")
    if load:
        ctl, atl, tsb, state = load
        lines.append(f"CTL (42-day fitness) {ctl:.0f}, ATL (7-day fatigue) {atl:.0f}, "
                     f"TSB (form) {tsb:+.0f} ({state})")
    else:
        lines.append("(no training data)")

    lines.append("\nRecent sessions (day, sport, minutes, load):")
    if sessions:
        for s in sessions[-10:]:
            lines.append(f"{s['day']} {s['sport']} {s['minutes']} min, load {_f(s.get('load'))}"
                         + (f" - {s['title']}" if s.get("title") else ""))
    else:
        lines.append("(none)")

    lines.append("\nNext race:")
    if race:
        lines.append(f"{race['name']} ({race['race_type']}) on {race['race_date']}, in {race['days']} days, "
                     f"phase {race['phase']}, priority {race['priority']}"
                     + (f", goal {race['goal']}" if race.get("goal") else ""))
        lines.append(f"Estimated form on race morning: {race['keep']:+.0f} if load stays at the 14-day average, "
                     f"{race['taper']:+.0f} with a {race['taper_days']}-day taper (planning estimates)")
    else:
        lines.append("(no upcoming race)")
    return "\n".join(lines)


_NOT_CHAT = ("image", "tts", "live", "audio", "embedding", "imagen", "veo", "robotics", "computer",
             "learnlm", "gemma", "nano", "banana", "aqa", "native")
_RETRY_WITH_NEXT = ("404", "NOT_FOUND", "429", "RESOURCE_EXHAUSTED", "403", "PERMISSION_DENIED")


def _client(api_key: str):
    from google import genai
    from google.genai import types
    # The "-latest" aliases and newer models live on v1beta.
    return genai.Client(api_key=api_key, http_options=types.HttpOptions(api_version="v1beta"))


def discover_models(client) -> list[str]:
    """Text models this API key can really call, best guess first (flash before lite before pro,
    stable before preview, newest first). Model names change often, so we ask Google instead of hardcoding."""
    found = []
    for m in client.models.list():
        name = (getattr(m, "name", "") or "").replace("models/", "")
        actions = getattr(m, "supported_actions", None) or []
        if not name.startswith("gemini-") or any(b in name for b in _NOT_CHAT):
            continue
        if actions and "generateContent" not in actions:
            continue
        found.append(name)

    def score(n: str):
        v = re.search(r"gemini-(\d+(?:\.\d+)?)", n)
        version = float(v.group(1)) if v else 0.0
        tier = 2 if ("flash" in n and "lite" not in n) else 1 if "lite" in n else 0
        stable = 0 if any(x in n for x in ("preview", "exp")) else 1
        return (tier, stable, version, 0 if n.endswith("-latest") else 1)

    return sorted(set(found), key=score, reverse=True)


def list_models(api_key: str) -> list[str]:
    return discover_models(_client(api_key))


def ask(api_key: str, preferred: list, context: str, history: list[dict], user_msg: str):
    """Call Gemini with the system prompt + athlete data. Returns (answer, model_used).
    Tries the preferred model ids first, then models discovered for this key. A model that is
    missing or out of quota is skipped and the next one is tried."""
    from google.genai import types

    client = _client(api_key)
    contents = [types.Content(role="user" if m["role"] == "user" else "model",
                              parts=[types.Part(text=m["content"])]) for m in history]
    contents.append(types.Content(role="user", parts=[types.Part(text=user_msg)]))
    config = types.GenerateContentConfig(system_instruction=f"{SYSTEM_PROMPT}\n\nATHLETE DATA\n{context}")

    candidates = [m for m in preferred if m]
    discovered, i, last = False, 0, None
    while True:
        if i >= len(candidates):
            if discovered:
                break
            candidates += [m for m in discover_models(client)[:5] if m not in candidates]
            discovered = True
            continue
        model, i = candidates[i], i + 1
        try:
            resp = client.models.generate_content(model=model, contents=contents, config=config)
            if resp.text:
                return resp.text, model
            last = RuntimeError(f"{model} returned an empty answer.")
        except Exception as e:
            last = e
            if not any(k in str(e) for k in _RETRY_WITH_NEXT):
                break
    raise last or RuntimeError("No Gemini model is available for this API key.")
