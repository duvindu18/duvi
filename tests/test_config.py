from app.core.config import AppConfig, Backend, Policy, Style


def test_roundtrip(tmp_path):
    cfg = AppConfig()
    cfg.engine.backend = Backend.YUNET
    cfg.anonymize.policy = Policy.ALL_EXCEPT_WHITELIST
    cfg.anonymize.style = Style.PIXELATE
    cfg.anonymize.box_color = (10, 20, 30)
    cfg.recognition.whitelist = ["Alice"]
    path = tmp_path / "c.json"
    cfg.save(path)
    loaded = AppConfig.load(path)
    assert loaded == cfg


def test_invalid_values_fall_back(tmp_path):
    path = tmp_path / "c.json"
    path.write_text('{"anonymize": {"policy": "bogus", "intensity": "x"}, "unknown": 1}')
    cfg = AppConfig.load(path)
    assert cfg.anonymize.policy == Policy.ALL
    assert cfg.anonymize.intensity == 70


def test_corrupt_file(tmp_path):
    path = tmp_path / "c.json"
    path.write_text("{not json")
    assert AppConfig.load(path) == AppConfig()
