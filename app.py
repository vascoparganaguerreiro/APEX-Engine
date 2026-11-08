"""APEX Engine - private beta, step 2: login + Today + RaceHub + Profile."""
from __future__ import annotations

from datetime import date, timedelta

import streamlit as st
from supabase import create_client

import engine

st.set_page_config(page_title="APEX Engine", page_icon="⚡", layout="wide")

CSS = """
<style>
.block-container,[data-testid="stMainBlockContainer"]{padding-top:4.5rem !important;max-width:1100px}
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


# ------------------------------------------------------------------- main
def main():
    st.markdown(CSS, unsafe_allow_html=True)
    if st.session_state.get("user") is None:
        auth_view()
        return
    with st.sidebar:
        st.markdown('<div class="apex-logo">⚡ APEX ENGINE</div>', unsafe_allow_html=True)
        st.caption(st.session_state.user.email)
        page = st.radio("Navigate", ["Today", "Races", "Profile"], label_visibility="collapsed")
        if st.button("Sign out"):
            sign_out()
            st.rerun()
    pages = {"Today": page_today, "Races": page_racehub, "Profile": page_profile}
    try:
        pages[page]()
    except Exception as e:
        if "jwt" in str(e).lower():
            sign_out()
            st.warning("Your session expired. Please sign in again.")
            st.rerun()
        st.error(f"Something went wrong: {e}")


main()
