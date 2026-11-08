from engine import banister, hrv_baseline, race_phase, readiness


def test_readiness_good_day_is_push():
    r = readiness(hrv=80, rhr=48, sleep_h=8, hrv_prior=[60] * 10, rhr_prior=[52] * 10)
    assert r.verdict == "PUSH" and r.score >= 70


def test_readiness_bad_day_is_recover():
    r = readiness(hrv=40, rhr=60, sleep_h=4.5, hrv_prior=[60] * 10, rhr_prior=[52] * 10)
    assert r.verdict == "RECOVER"


def test_readiness_no_data_returns_none():
    assert readiness(None, None, None) is None


def test_readiness_without_baseline_is_neutral_not_crashing():
    r = readiness(hrv=60, rhr=50, sleep_h=8)
    assert r is not None and r.baseline_days == 0


def test_baseline_needs_three_days():
    assert hrv_baseline([60, 62]) is None
    assert hrv_baseline([60, 62, 64]) is not None


def test_race_phase():
    assert race_phase(-1, "marathon") == "Completed"
    assert race_phase(0, "marathon") == "Race day"
    assert race_phase(10, "marathon") == "Taper"
    assert race_phase(60, "marathon") == "Build"
    assert race_phase(200, "marathon") == "Base"


def test_banister_converges_to_constant_load():
    out = banister([50] * 400)
    ctl, atl, tsb = out[-1]
    assert abs(ctl - 50) < 0.1 and abs(atl - 50) < 0.1 and abs(tsb) < 0.1
