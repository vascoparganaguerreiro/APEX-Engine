from datetime import date

import coach
import engine


def test_context_has_key_facts():
    res = engine.readiness(68, 52, 7.6, [60] * 10, [50] * 10)
    ctx = coach.build_context(
        date(2026, 11, 9), {"weight_kg": 78, "max_hr": 196},
        [{"day": "2026-11-09", "hrv_ms": 68, "rhr_bpm": 52, "sleep_minutes": 459, "sleep_score": 74,
          "body_battery": 63, "stress_avg": 22}],
        [{"day": "2026-11-08", "sport": "bike", "minutes": 186, "load": 92.9, "title": "Ride"}],
        (73, 49, 24, "Peak form window"), res,
        {"name": "10K", "race_type": "10k", "race_date": "2026-12-13", "days": 34, "phase": "Build",
         "priority": "A", "goal": "sub 41", "keep": 11, "taper": 22, "taper_days": 5})
    for text in ("HRV 68 ms", "CTL (42-day fitness) 73", "10K", "sub 41", "bike 186 min"):
        assert text in ctx


def test_context_handles_missing_data():
    ctx = coach.build_context(date(2026, 11, 9), {}, [], [], None, None, None)
    assert "(no daily data)" in ctx and "(no upcoming race)" in ctx


import sys
import types as _t


class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def _fake_genai(behaviour, models):
    """Install a fake google.genai whose generate_content follows behaviour[model] (an exception or text)."""
    class Models:
        def list(self):
            return [_Obj(name="models/" + n, supported_actions=a) for n, a in models]

        def generate_content(self, model, contents, config):
            out = behaviour.get(model, RuntimeError("404 NOT_FOUND"))
            if isinstance(out, Exception):
                raise out
            return _Obj(text=out)

    class Client:
        def __init__(self, **kw):
            self.models = Models()

    g = _t.ModuleType("google.genai")
    g.Client = Client
    g.types = _t.SimpleNamespace(HttpOptions=lambda **k: None, Content=lambda **k: None,
                                 Part=lambda **k: None, GenerateContentConfig=lambda **k: None)
    pkg = _t.ModuleType("google")
    pkg.genai = g
    sys.modules.update({"google": pkg, "google.genai": g, "google.genai.types": g.types})


GEN = ["generateContent"]
LISTED = [("gemini-2.5-flash", GEN), ("gemini-3.8-flash", GEN), ("gemini-3.8-flash-lite", GEN),
          ("gemini-3.8-pro", GEN), ("gemini-3.8-flash-tts", ["generateContent"]),
          ("gemini-embedding-2", ["embedContent"]), ("gemma-3-27b", GEN),
          ("gemini-3.9-flash-preview", GEN)]


def test_discover_prefers_stable_newest_flash():
    _fake_genai({}, LISTED)
    names = coach.discover_models(coach._client("k"))
    assert names[0] == "gemini-3.8-flash"
    assert all("tts" not in n and "embedding" not in n and "gemma" not in n for n in names)


def test_ask_skips_retired_model_and_discovers_a_working_one():
    _fake_genai({"gemini-3.8-flash": "Train easy tomorrow."}, LISTED)
    text, model = coach.ask("k", ["gemini-2.5-flash", None], "ctx", [], "hi")
    assert (text, model) == ("Train easy tomorrow.", "gemini-3.8-flash")


def test_ask_moves_to_next_model_when_quota_is_out():
    _fake_genai({"gemini-3.8-flash": RuntimeError("429 RESOURCE_EXHAUSTED"),
                 "gemini-3.8-flash-lite": "ok"}, LISTED)
    assert coach.ask("k", [], "ctx", [], "hi")[1] == "gemini-3.8-flash-lite"


def test_ask_raises_clear_error_when_nothing_works():
    _fake_genai({}, LISTED)
    try:
        coach.ask("k", [], "ctx", [], "hi")
        assert False, "should have raised"
    except RuntimeError as e:
        assert "404" in str(e)


def test_ask_does_not_retry_on_unrelated_errors():
    _fake_genai({"gemini-3.8-flash": RuntimeError("400 INVALID_ARGUMENT bad request")}, LISTED)
    try:
        coach.ask("k", [], "ctx", [], "hi")
        assert False, "should have raised"
    except RuntimeError as e:
        assert "INVALID_ARGUMENT" in str(e)
