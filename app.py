"""APEX Engine - private beta, step 2: login + Today + RaceHub + Profile."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

import pandas as pd
import streamlit as st
from supabase import create_client

import coach
import engine

st.set_page_config(page_title="APEX Engine", page_icon="⚡", layout="wide")

CSS = """
<style>
.block-container{padding-top:2rem;max-width:1100px}
h1,h2,h3{letter-spacing:-.02em}
.apex-logo{font-weight:800;letter-spacing:.22em;font-size:14px}
.apex-ey{font-size:11px;letter-spacing:.24em;font-weight:700;color:#2ee6a6;text-transform:uppercase}
.apex-card{background:linear-gradient(180deg,#0e1319,#0a0e13);border:1px solid #1b232d;
  border-radius:18px;padding:20px;margin-bottom:12px}
.apex-muted{color:#8d99a8;font-size:13px}
.apex-verdict{font-size:24px;font-weight:800;letter-spacing:-.02em}
div[data-testid="stMetric"]{background:#0e1319;border:1px solid #1b232d;border-radius:14px;padding:14px}
.stButton>button,.stFormSubmitButton>button{background:linear-gradient(135deg,#2ee6a6,#4da3ff);
  color:#031210;font-weight:700;border:0;border-radius:12px}
</style>
"""

VERDICTS = {
    "PUSH": ("Push", "#2ee6a6", "Green light for a quality session."),
    "HOLD": ("Hold the plan", "#ffb84d", "Train as planned, no extra intensity."),
    "RECOVER": ("Recover", "#ff6b6b", "Prioritise sleep and easy movement."),
}
RACE_TYPES = {
    "marathon": "Marathon", "half_marathon": "Half marathon", "10k": "10K",
    "triathlon_sprint": "Triathlon (sprint)", "triathlon_olympic": "Triathlon (olympic)",
    "half_ironman": "Half Ironman", "ironman": "Ironman", "trail": "Trail run",
    "cycling": "Cycling event", "other": "Other",
}


# ---------------------------------------------------------------- helpers
def sb():
    """One Supabase client per browser session (never shared between users)."""
    if "sb" not in st.session_state:
        cfg = st.secrets["supabase"]
        st.session_state.sb = create_client(cfg["url"], cfg["anon_key"])
    return st.session_state.sb


def uid() -> str:
    return st.session_state.user.id


def sign_out():
    try:
        sb().auth.sign_out()
    except Exception:
        pass
    for k in ("sb", "user"):
        st.session_state.pop(k, None)


def get_profile() -> dict:
    rows = sb().table("profiles").select("*").eq("id", uid()).execute().data
    return rows[0] if rows else {}


def ring_svg(score: int, color: str) -> str:
    circ = 477.5
    off = circ * (1 - score / 100)
    return f"""
    <div style="position:relative;width:190px;height:190px;margin:auto">
      <svg width="190" height="190" viewBox="0 0 180 180" style="transform:rotate(-90deg)">
        <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#2ee6a6"/><stop offset="1" stop-color="#4da3ff"/></linearGradient></defs>
        <circle cx="90" cy="90" r="76" fill="none" stroke="#1b232d" stroke-width="12"/>
        <circle cx="90" cy="90" r="76" fill="none" stroke="url(#rg)" stroke-width="12"
                stroke-linecap="round" stroke-dasharray="{circ}" stroke-dashoffset="{off}"/>
      </svg>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
        <div style="font-size:48px;font-weight:800;line-height:1;color:{color}">{score}</div>
        <div style="font-size:11px;letter-spacing:.15em;color:#8d99a8">READINESS</div>
      </div></div>"""


# ------------------------------------------------------------------- auth
def auth_view():
    st.markdown('<div class="apex-logo">⚡ APEX ENGINE</div>', unsafe_allow_html=True)
    st.markdown('<div class="apex-ey" style="margin-top:40px">Private beta</div>', unsafe_allow_html=True)
    st.title("Your data, finally turned into decisions.")
    st.caption("Access is by invitation only. Use the email address you were invited with.")
    tab_in, tab_up = st.tabs(["Sign in", "Create account"])

    with tab_in:
        with st.form("signin"):
            email = st.text_input("Email")
            pw = st.text_input("Password", type="password")
            go = st.form_submit_button("Sign in")
        if go:
            try:
                res = sb().auth.sign_in_with_password({"email": email.strip(), "password": pw})
                st.session_state.user = res.user
                st.rerun()
            except Exception as e:
                st.error("Sign-in failed. Check your email and password.")
                with st.expander("Technical detail"):
                    st.code(str(e))

    with tab_up:
        with st.form("signup"):
            email = st.text_input("Invited email")
            pw = st.text_input("Choose a password (min. 8 characters)", type="password")
            go = st.form_submit_button("Create account")
        if go:
            if len(pw) < 8:
                st.error("Password must have at least 8 characters.")
            else:
                try:
                    res = sb().auth.sign_up({"email": email.strip(), "password": pw})
                    if res.session:
                        st.session_state.user = res.user
                        st.rerun()
                    else:
                        st.success("Account created. Check your email to confirm it, then sign in.")
                except Exception as e:
                    st.error("Could not create the account. In this private beta only invited emails can register.")
                    with st.expander("Technical detail"):
                        st.code(str(e))


# ------------------------------------------------------------------ pages
def page_today():
    st.markdown('<div class="apex-ey">Command Center</div>', unsafe_allow_html=True)
    st.title("Today")
    since = (date.today() - timedelta(days=15)).isoformat()
    rows = (sb().table("daily_metrics").select("day,hrv_ms,rhr_bpm,sleep_minutes")
            .gte("day", since).order("day").execute().data or [])
    goal = float(get_profile().get("sleep_goal_h") or 8.0)

    if rows:
        latest = rows[-1]
        prior = [r for r in rows if r["day"] != latest["day"]][-14:]
        sleep_h = latest["sleep_minutes"] / 60 if latest.get("sleep_minutes") else None
        res = engine.readiness(
            hrv=latest.get("hrv_ms"), rhr=latest.get("rhr_bpm"), sleep_h=sleep_h,
            hrv_prior=[r.get("hrv_ms") for r in prior],
            rhr_prior=[r.get("rhr_bpm") for r in prior], sleep_goal_h=goal)
        if res:
            title, color, text = VERDICTS[res.verdict]
            c1, c2 = st.columns([1, 2])
            with c1:
                st.markdown(ring_svg(res.score, color), unsafe_allow_html=True)
            with c2:
                st.markdown(f'<div class="apex-verdict" style="color:{color}">{title}</div>', unsafe_allow_html=True)
                st.write(text)
                st.caption(f"Latest entry: {latest['day']} · HRV baseline: {res.baseline_days}/14 days"
                           + (" (still building, score is provisional)" if res.baseline_days < 3 else ""))
                k1, k2, k3 = st.columns(3)
                hrv = latest.get("hrv_ms")
                k1.metric("Overnight HRV", f"{float(hrv):.0f} ms" if hrv is not None else "n/a",
                          f"{res.hrv_z:+.1f} σ" if res.hrv_z is not None else None)
                k2.metric("Resting HR", f"{latest['rhr_bpm']} bpm" if latest.get("rhr_bpm") else "n/a")
                k3.metric("Sleep", f"{sleep_h:.1f} h" if sleep_h else "n/a", f"goal {goal:.1f} h", delta_color="off")
    else:
        st.info("No data yet. Log your first day below to see your readiness.")

    st.subheader("Log a day")
    with st.form("log_day"):
        c1, c2, c3, c4 = st.columns(4)
        d = c1.date_input("Date", value=date.today(), max_value=date.today())
        hrv = c2.number_input("Overnight HRV (ms)", 0.0, 250.0, 60.0, 1.0)
        rhr = c3.number_input("Resting HR (bpm)", 30, 120, 52)
        sl = c4.number_input("Sleep (hours)", 0.0, 14.0, 7.5, 0.25)
        ok = st.form_submit_button("Save")
    if ok:
        try:
            sb().table("daily_metrics").upsert({
                "user_id": uid(), "day": d.isoformat(), "hrv_ms": hrv, "rhr_bpm": int(rhr),
                "sleep_minutes": int(round(sl * 60)), "source": "manual"},
                on_conflict="user_id,day").execute()
            st.rerun()
        except Exception as e:
            st.error(f"Could not save: {e}")


def page_racehub():
    st.markdown('<div class="apex-ey">RaceHub</div>', unsafe_allow_html=True)
    st.title("Races")
    today = date.today()
    races = sb().table("races").select("*").order("race_date").execute().data or []
    upcoming = [r for r in races if date.fromisoformat(r["race_date"]) >= today]

    if not upcoming:
        st.info("No upcoming races. Add your first one below.")
    for r in upcoming:
        rd = date.fromisoformat(r["race_date"])
        days = (rd - today).days
        phase = engine.race_phase(days, r["race_type"])
        with st.container(border=True):
            a, b, c = st.columns([3, 1, 1])
            a.markdown(f"**{r['name']}**  \n<span class='apex-muted'>{RACE_TYPES.get(r['race_type'], r['race_type'])}"
                       f" · {rd:%d %b %Y} · priority {r['priority']}"
                       + (f" · goal: {r['goal']}" if r.get("goal") else "") + "</span>", unsafe_allow_html=True)
            b.metric("Countdown", f"{days} d", phase, delta_color="off")
            if c.button("Delete", key=f"del{r['id']}"):
                sb().table("races").delete().eq("id", r["id"]).execute()
                st.rerun()

    st.subheader("Add a race")
    with st.form("add_race"):
        name = st.text_input("Race name")
        c1, c2, c3 = st.columns(3)
        rdate = c1.date_input("Race date", value=today + timedelta(days=90), min_value=today)
        rtype = c2.selectbox("Type", list(RACE_TYPES), format_func=RACE_TYPES.get)
        prio = c3.selectbox("Priority", ["A", "B", "C"], index=1)
        goal = st.text_input("Goal (optional, e.g. sub-3:30)")
        ok = st.form_submit_button("Add race")
    if ok:
        if not name.strip():
            st.error("Please give the race a name.")
        else:
            try:
                sb().table("races").insert({
                    "user_id": uid(), "name": name.strip(), "race_date": rdate.isoformat(),
                    "race_type": rtype, "priority": prio, "goal": goal.strip() or None}).execute()
                st.rerun()
            except Exception as e:
                st.error(f"Could not save: {e}")


def page_profile():
    st.markdown('<div class="apex-ey">Account</div>', unsafe_allow_html=True)
    st.title("Profile")
    p = get_profile()
    with st.form("profile"):
        name = st.text_input("Display name", p.get("display_name") or "")
        c1, c2, c3, c4 = st.columns(4)
        w = c1.number_input("Weight (kg)", 30.0, 200.0, float(p.get("weight_kg") or 70.0), 0.5)
        h = c2.number_input("Height (cm)", 120.0, 230.0, float(p.get("height_cm") or 175.0), 0.5)
        mhr = c3.number_input("Max HR (bpm)", 120, 230, int(p.get("max_hr") or 185))
        ftp = c4.number_input("FTP (watts)", 0, 600, int(p.get("ftp_watts") or 0))
        sg = st.number_input("Sleep goal (hours)", 5.0, 11.0, float(p.get("sleep_goal_h") or 8.0), 0.25)
        tz = st.text_input("Time zone", p.get("timezone") or "Europe/Lisbon")
        ok = st.form_submit_button("Save profile")
    if ok:
        try:
            sb().table("profiles").update({
                "display_name": name.strip() or None, "weight_kg": w, "height_cm": h,
                "max_hr": int(mhr), "ftp_watts": int(ftp) or None, "sleep_goal_h": sg,
                "timezone": tz.strip() or "Europe/Lisbon"}).eq("id", uid()).execute()
            st.success("Saved.")
        except Exception as e:
            st.error(f"Could not save: {e}")


SPORTS = {"run": "Run", "bike": "Bike", "swim": "Swim", "strength": "Strength", "other": "Other"}


def page_training():
    st.markdown('<div class="apex-ey">Performance</div>', unsafe_allow_html=True)
    st.title("Training load")
    today = date.today()
    since = (today - timedelta(days=200)).isoformat()
    acts = (sb().table("activities")
            .select("id,started_at,sport,title,duration_s,distance_m,rpe,load")
            .gte("started_at", since).order("started_at").execute().data or [])
    daily: dict = {}
    for a in acts:
        d = date.fromisoformat(a["started_at"][:10])
        daily[d] = daily.get(d, 0.0) + float(a.get("load") or 0)

    if daily:
        series = engine.load_series(daily, today - timedelta(days=180), today)
        _, _, ctl, atl, tsb = series[-1]
        m1, m2, m3 = st.columns(3)
        m1.metric("Fitness (CTL)", f"{ctl:.0f}")
        m2.metric("Fatigue (ATL)", f"{atl:.0f}")
        m3.metric("Form (TSB)", f"{tsb:+.0f}", engine.tsb_state(tsb), delta_color="off")
        df = pd.DataFrame(series[-90:], columns=["day", "Load", "CTL", "ATL", "TSB"]).set_index("day")
        st.line_chart(df[["CTL", "ATL", "TSB"]], color=["#2ee6a6", "#ff6b6b", "#4da3ff"])
        st.caption("Last 90 days. CTL = 42-day fitness, ATL = 7-day fatigue, TSB = CTL minus ATL.")

        nxt = (sb().table("races").select("name,race_date,race_type")
               .gte("race_date", today.isoformat()).order("race_date").limit(1).execute().data)
        if nxt:
            r = nxt[0]
            days = (date.fromisoformat(r["race_date"]) - today).days
            avg14 = sum(daily.get(today - timedelta(days=i), 0.0) for i in range(14)) / 14
            taper = engine.TAPER_DAYS.get(r["race_type"], 10)
            keep = engine.project_tsb(ctl, atl, days, avg14)
            tap = engine.project_tsb(ctl, atl, days, avg14, taper_days=taper)
            st.subheader(f"Race-day form: {r['name']}")
            c1, c2 = st.columns(2)
            c1.metric("Keep current load", f"{keep:+.0f}", engine.tsb_state(keep), delta_color="off")
            c2.metric(f"With a {taper}-day taper", f"{tap:+.0f}", engine.tsb_state(tap), delta_color="off")
            st.caption(f"{days} days to go. Assumes your 14-day average load ({avg14:.0f}/day) until the taper, "
                       "then half of it. A planning estimate, not a prediction.")
    else:
        st.info("No training sessions yet. Import your Garmin history or log a session below.")

    st.subheader("Log a session")
    with st.form("log_session"):
        c1, c2, c3 = st.columns(3)
        d = c1.date_input("Date", value=today, max_value=today)
        sport = c2.selectbox("Sport", list(SPORTS), format_func=SPORTS.get)
        minutes = c3.number_input("Duration (min)", 5, 720, 45)
        c4, c5, c6 = st.columns(3)
        rpe = c4.slider("Effort (RPE 1-10)", 1, 10, 5)
        km = c5.number_input("Distance (km, optional)", 0.0, 500.0, 0.0, 0.1)
        override = c6.number_input("Load override (0 = auto)", 0.0, 1000.0, 0.0, 1.0)
        title = st.text_input("Title (optional)")
        ok = st.form_submit_button("Save session")
    if ok:
        load = override or engine.estimate_load(minutes, rpe)
        try:
            sb().table("activities").insert({
                "user_id": uid(), "started_at": f"{d.isoformat()}T12:00:00+00:00", "sport": sport,
                "title": title.strip() or None, "duration_s": int(minutes) * 60,
                "distance_m": km * 1000 if km else None, "rpe": rpe, "load": load,
                "source": "manual"}).execute()
            st.rerun()
        except Exception as e:
            st.error(f"Could not save: {e}")

    recent = list(reversed(acts))[:10]
    if recent:
        st.subheader("Recent sessions")
        st.dataframe(pd.DataFrame([{
            "Date": x["started_at"][:10], "Sport": SPORTS.get(x["sport"], x["sport"]),
            "Title": x.get("title") or "", "Min": round((x.get("duration_s") or 0) / 60),
            "Load": x.get("load")} for x in recent]), hide_index=True)
        with st.expander("Delete a session"):
            opts = {x["id"]: f"{x['started_at'][:10]} · {SPORTS.get(x['sport'], x['sport'])} · "
                             f"{round((x.get('duration_s') or 0) / 60)} min" for x in recent}
            sel = st.selectbox("Session", list(opts), format_func=opts.get)
            if st.button("Delete session"):
                sb().table("activities").delete().eq("id", sel).execute()
                st.rerun()


def gather_context():
    """Read the athlete's data and turn it into the text the coach sees."""
    today = date.today()
    prof = get_profile()
    rows = (sb().table("daily_metrics")
            .select("day,hrv_ms,rhr_bpm,sleep_minutes,sleep_score,body_battery,stress_avg")
            .gte("day", (today - timedelta(days=15)).isoformat()).order("day").execute().data or [])
    acts = (sb().table("activities").select("started_at,sport,title,duration_s,load")
            .gte("started_at", (today - timedelta(days=200)).isoformat()).order("started_at").execute().data or [])

    res = None
    if rows:
        latest = rows[-1]
        prior = [r for r in rows if r["day"] != latest["day"]][-14:]
        sleep_h = latest["sleep_minutes"] / 60 if latest.get("sleep_minutes") else None
        res = engine.readiness(
            hrv=latest.get("hrv_ms"), rhr=latest.get("rhr_bpm"), sleep_h=sleep_h,
            hrv_prior=[r.get("hrv_ms") for r in prior], rhr_prior=[r.get("rhr_bpm") for r in prior],
            sleep_goal_h=float(prof.get("sleep_goal_h") or 8.0))

    daily: dict = {}
    for x in acts:
        d = date.fromisoformat(x["started_at"][:10])
        daily[d] = daily.get(d, 0.0) + float(x.get("load") or 0)
    load, race = None, None
    if daily:
        _, _, ctl, atl, tsb = engine.load_series(daily, today - timedelta(days=180), today)[-1]
        load = (ctl, atl, tsb, engine.tsb_state(tsb))
        nxt = (sb().table("races").select("name,race_date,race_type,priority,goal")
               .gte("race_date", today.isoformat()).order("race_date").limit(1).execute().data)
        if nxt:
            r = nxt[0]
            days = (date.fromisoformat(r["race_date"]) - today).days
            avg14 = sum(daily.get(today - timedelta(days=i), 0.0) for i in range(14)) / 14
            taper = engine.TAPER_DAYS.get(r["race_type"], 10)
            race = {**r, "days": days, "phase": engine.race_phase(days, r["race_type"]), "taper_days": taper,
                    "keep": engine.project_tsb(ctl, atl, days, avg14),
                    "taper": engine.project_tsb(ctl, atl, days, avg14, taper_days=taper)}
    sessions = [{"day": x["started_at"][:10], "sport": x["sport"], "title": x.get("title"),
                 "minutes": round((x.get("duration_s") or 0) / 60), "load": x.get("load")} for x in acts]
    return coach.build_context(today, prof, rows, sessions, load, res, race)


STARTERS = ["Should I train hard today?", "How is my recovery trending?",
            "How should I prepare for my next race?", "What should I eat before and after a hard session?"]


def page_coach():
    st.markdown('<div class="apex-ey">Insights</div>', unsafe_allow_html=True)
    st.title("AI Coach")
    cfg = st.secrets.get("gemini", {})
    key = cfg.get("api_key")
    if not key:
        st.warning("The AI Coach is not set up yet: add your Gemini key under [gemini] in the app Secrets.")
        return
    preferred = [st.session_state.get("coach_model"), cfg.get("model")]
    limit = int(cfg.get("daily_limit") or 20)
    st.caption("Answers are based on your own APEX data. A summary of it is sent to Google's Gemini to write each "
               "answer. Guidance only, not medical advice.")

    hist = (sb().table("coach_messages").select("role,content").order("created_at", desc=True)
            .limit(40).execute().data or [])[::-1]
    for m in hist:
        st.chat_message(m["role"]).write(m["content"])

    prompt = st.chat_input("Ask your coach...") or st.session_state.pop("coach_prefill", None)
    if not hist and not prompt:
        cols = st.columns(2)
        for i, q in enumerate(STARTERS):
            if cols[i % 2].button(q, key=f"starter{i}"):
                st.session_state.coach_prefill = q
                st.rerun()

    if prompt:
        start = datetime.combine(date.today(), time.min, tzinfo=timezone.utc).isoformat()
        used = sb().table("coach_messages").select("id", count="exact").eq("role", "user") \
            .gte("created_at", start).execute().count or 0
        if used >= limit:
            st.warning(f"Daily limit of {limit} questions reached. Come back tomorrow.")
        else:
            st.chat_message("user").write(prompt)
            with st.chat_message("assistant"):
                try:
                    with st.spinner("Thinking..."):
                        reply, used = coach.ask(key, preferred, gather_context(), hist[-20:], prompt)
                    st.session_state.coach_model = used
                    st.write(reply)
                    st.caption(f"Model: {used}")
                    sb().table("coach_messages").insert([
                        {"user_id": uid(), "role": "user", "content": prompt},
                        {"user_id": uid(), "role": "assistant", "content": reply}]).execute()
                except Exception as e:
                    msg = str(e)
                    if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
                        st.warning("The free Gemini quota is used up for now. Try again later.")
                    elif "API key" in msg or "API_KEY" in msg:
                        st.error("Gemini rejected the API key. Check the [gemini] key in the app Secrets.")
                    else:
                        st.error(f"The coach could not answer: {msg[:300]}")

    with st.expander("Troubleshooting"):
        if st.button("List the Gemini models my key can use"):
            try:
                st.write(coach.list_models(key) or "No usable text models found for this key.")
            except Exception as e:
                st.error(str(e)[:300])

    if hist and st.button("Clear conversation"):
        sb().table("coach_messages").delete().eq("user_id", uid()).execute()
        st.rerun()


# ------------------------------------------------------------------- main
def main():
    st.markdown(CSS, unsafe_allow_html=True)
    if st.session_state.get("user") is None:
        auth_view()
        return
    with st.sidebar:
        st.markdown('<div class="apex-logo">⚡ APEX ENGINE</div>', unsafe_allow_html=True)
        st.caption(st.session_state.user.email)
        page = st.radio("Navigate", ["Today", "Training", "Coach", "Races", "Profile"], label_visibility="collapsed")
        if st.button("Sign out"):
            sign_out()
            st.rerun()
    pages = {"Today": page_today, "Training": page_training, "Coach": page_coach, "Races": page_racehub, "Profile": page_profile}
    try:
        pages[page]()
    except Exception as e:
        if "jwt" in str(e).lower():
            sign_out()
            st.warning("Your session expired. Please sign in again.")
            st.rerun()
        st.error(f"Something went wrong: {e}")


main()
