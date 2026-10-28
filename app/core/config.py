"""Typed application configuration, persisted as JSON.

The configuration is split into sections that map 1:1 onto UI cards. Every
section is a plain dataclass so it can be copied cheaply and handed to worker
threads as an immutable snapshot (workers never read the live GUI object).
"""

from __future__ import annotations

import copy
import json
import logging
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from enum import Enum
from pathlib import Path
from typing import Any, TypeVar

from app.utils.paths import config_file, default_faces_dir

log = logging.getLogger(__name__)


class Backend(str, Enum):
    INSIGHTFACE = "insightface"  # SCRFD detector + ArcFace (buffalo_l) via ONNX Runtime
    YUNET = "yunet"  # OpenCV YuNet detector + SFace recognizer (lightweight CPU / OpenCV-CUDA)


class Device(str, Enum):
    AUTO = "auto"
    TENSORRT = "tensorrt"
    CUDA = "cuda"
    DIRECTML = "directml"
    OPENVINO = "openvino"
    CPU = "cpu"


class Policy(str, Enum):
    ALL = "all"  # anonymize every face
    UNKNOWN = "unknown"  # Option A: anonymize strangers (not in the database)
    TARGETS = "targets"  # Option A: anonymize only selected identities
    ALL_EXCEPT_WHITELIST = "whitelist"  # Option B: anonymize everyone except whitelisted identities
    NONE = "none"  # detect / recognise only


class Style(str, Enum):
    GAUSSIAN = "gaussian"
    PIXELATE = "pixelate"
    BLACK_BOX = "blackbox"
    MASK = "mask"


class Shape(str, Enum):
    ELLIPSE = "ellipse"
    RECTANGLE = "rectangle"


@dataclass
class EngineConfig:
    backend: Backend = Backend.INSIGHTFACE
    device: Device = Device.AUTO
    gpu_id: int = 0
    gpu_mem_limit_mb: int = 0  # 0 = unlimited
    tensorrt_fp16: bool = True
    insightface_pack: str = "buffalo_l"  # buffalo_l (accurate) or buffalo_s (fast)
    # Defaults favour recall: a missed face is a privacy leak, a false positive
    # only blurs a patch of background.
    det_size: int = 0  # 0 = auto: 960 on GPU (small/distant faces), 640 on CPU
    det_threshold: float = 0.35
    det_low_threshold: float = 0.15  # second-stage ByteTrack association
    min_face_px: int = 10
    # Extra rotated detection passes for tilted / sideways / upside-down faces:
    # "off", "tilt" (±40°) or "full" (any in-plane rotation).
    rotation_coverage: str = "full"
    rotation_passes: int = 0  # rotated passes per frame; 0 = auto (2 on GPU, 1 on CPU)
    cpu_threads: int = 0  # 0 = let the runtime decide


@dataclass
class TrackerConfig:
    high_threshold: float = 0.35
    match_iou: float = 0.3
    low_match_iou: float = 0.5
    new_track_threshold: float = 0.35
    max_lost_frames: int = 30
    min_hits: int = 1  # anonymize from the very first frame a face appears


@dataclass
class RecognitionConfig:
    enabled: bool = True
    faces_dir: str = field(default_factory=lambda: str(default_faces_dir()))
    match_threshold: float = 0.40  # cosine similarity, ArcFace; SFace uses ~0.36
    recognize_every_n: int = 5  # frames between attempts while a track is unidentified
    reverify_every_n: int = 45  # frames between re-checks of an identified track
    max_per_frame: int = 4  # bounds recognition latency in crowded scenes
    vote_window: int = 7
    whitelist: list[str] = field(default_factory=list)
    targets: list[str] = field(default_factory=list)


@dataclass
class AnonymizeConfig:
    policy: Policy = Policy.ALL
    style: Style = Style.GAUSSIAN
    shape: Shape = Shape.ELLIPSE
    intensity: int = 70  # 1..100, maps to kernel size / block size
    padding: float = 0.2  # coverage: 0 = face oval only, larger values extend to hairline / ears
    feather: bool = True
    mask_path: str = ""
    box_color: tuple[int, int, int] = (0, 0, 0)
    fail_closed: bool = True  # anonymize faces that have not been identified yet
    persist_lost_frames: int = 8  # keep blurring a briefly-occluded face to avoid flicker
    show_boxes: bool = True
    show_labels: bool = True


@dataclass
class OutputConfig:
    codec: str = "auto"  # auto | mp4v | avc1 | XVID | MJPG
    keep_audio_hint: bool = False
    export_dir: str = ""


@dataclass
class AppConfig:
    engine: EngineConfig = field(default_factory=EngineConfig)
    tracker: TrackerConfig = field(default_factory=TrackerConfig)
    recognition: RecognitionConfig = field(default_factory=RecognitionConfig)
    anonymize: AnonymizeConfig = field(default_factory=AnonymizeConfig)
    output: OutputConfig = field(default_factory=OutputConfig)
    display_name: str = ""  # greeting on the Live page; empty = Windows user name
    preview_mode: str = "smooth"  # "smooth": every frame shown, async detection; "exact": every shown frame detected
    volume: float = 1.0
    muted: bool = False
    loop: bool = False
    last_source_kind: str = "webcam"
    last_source_value: str = "0"
    window_geometry: str = ""

    def snapshot(self) -> "AppConfig":
        return copy.deepcopy(self)

    # ---- persistence -------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        return _encode(asdict(self))

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AppConfig":
        return _decode(cls, data)

    def save(self, path: Path | None = None) -> None:
        target = path or config_file()
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")
        tmp.replace(target)  # atomic on NTFS

    @classmethod
    def load(cls, path: Path | None = None) -> "AppConfig":
        source = path or config_file()
        if not source.exists():
            return cls()
        try:
            return cls.from_dict(json.loads(source.read_text(encoding="utf-8")))
        except (OSError, ValueError, TypeError) as exc:
            log.warning("Config %s is unreadable (%s); using defaults.", source, exc)
            return cls()


def _encode(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {k: _encode(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_encode(v) for v in value]
    return value


T = TypeVar("T")


def _decode(cls: type[T], data: dict[str, Any]) -> T:
    """Rebuild a dataclass tree, ignoring unknown keys and invalid values."""
    defaults = cls()
    kwargs: dict[str, Any] = {}
    for f in fields(cls):  # type: ignore[arg-type]
        if f.name not in data:
            continue
        raw = data[f.name]
        current = getattr(defaults, f.name)
        try:
            if is_dataclass(current):
                kwargs[f.name] = _decode(type(current), raw if isinstance(raw, dict) else {})
            elif isinstance(current, Enum):
                kwargs[f.name] = type(current)(raw)
            elif isinstance(current, tuple):
                kwargs[f.name] = tuple(raw)
            elif isinstance(current, bool):
                kwargs[f.name] = bool(raw)
            elif isinstance(current, (int, float)) and not isinstance(raw, bool):
                kwargs[f.name] = type(current)(raw)
            else:
                kwargs[f.name] = raw
        except (ValueError, TypeError):
            log.warning("Ignoring invalid config value %s=%r", f.name, raw)
    return cls(**kwargs)
