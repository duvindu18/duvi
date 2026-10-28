"""Selective anonymization: decides *who* to hide and renders *how*.

Rendering works on an oriented face ellipse (or rectangle) that follows the
head's tilt and is sized from the face itself (see :meth:`Anonymizer.face_shape`). Effects are
computed on a down-scaled copy of the ROI where possible (Gaussian blur cost
grows with kernel area) and composited back through an elliptical, optionally
feathered alpha mask so the result looks natural rather than boxy.
"""

from __future__ import annotations

import logging
import math
import threading

import cv2
import numpy as np

from app.core.config import AnonymizeConfig, Policy, RecognitionConfig, Shape, Style
from app.core.engine_types import DEFAULT_MARGIN, geom_from_bbox
from app.utils.imageio import imread

log = logging.getLogger(__name__)


def should_anonymize(
    identity: str | None,
    recognized: bool,
    anon: AnonymizeConfig,
    rec: RecognitionConfig,
) -> bool:
    policy = anon.policy
    if policy == Policy.ALL:
        return True
    if policy == Policy.NONE:
        return False
    if not rec.enabled:
        # Without recognition every face is a stranger.
        identity, recognized = None, True
    if not recognized:
        return anon.fail_closed
    if policy == Policy.UNKNOWN:
        return identity is None
    if policy == Policy.TARGETS:
        return identity is not None and identity in rec.targets
    if policy == Policy.ALL_EXCEPT_WHITELIST:
        return identity is None or identity not in rec.whitelist
    return True


def _builtin_mask(size: int = 256) -> np.ndarray:
    """Procedural BGRA mask in the app's ember palette (used when no PNG is set)."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / (size - 1)
    top = np.array([44, 90, 255], np.float32)  # BGR #FF5A2C
    bottom = np.array([20, 30, 150], np.float32)  # BGR #961E14
    t = yy[..., None]
    rgb = top * (1 - t) + bottom * t
    # Soft highlight, like the glossy cards in the reference design.
    glow = np.exp(-(((xx - 0.35) ** 2 + (yy - 0.3) ** 2) / 0.05))[..., None]
    rgb = np.clip(rgb + glow * 90, 0, 255)
    d = np.sqrt((xx - 0.5) ** 2 + (yy - 0.5) ** 2)
    alpha = np.clip((0.5 - d) * size / 3, 0, 1) * 255
    mask = np.dstack([rgb, alpha]).astype(np.uint8)
    # Minimal "eyes" so the mask reads as a face cover.
    for cx in (0.36, 0.64):
        cv2.ellipse(mask, (int(cx * size), int(0.45 * size)), (size // 16, size // 26), 0, 0, 360, (255, 255, 255, 230), -1, cv2.LINE_AA)
    return mask


class Anonymizer:
    def __init__(self, cfg: AnonymizeConfig) -> None:
        self._lock = threading.Lock()
        self._mask_bgra: np.ndarray | None = None
        self._mask_source: str | None = None
        self.cfg = cfg
        self.set_config(cfg)

    def set_config(self, cfg: AnonymizeConfig) -> None:
        with self._lock:
            self.cfg = cfg
            if cfg.style == Style.MASK and cfg.mask_path != self._mask_source:
                self._mask_bgra = self._load_mask(cfg.mask_path)
                self._mask_source = cfg.mask_path

    @staticmethod
    def _load_mask(path: str) -> np.ndarray:
        if path:
            img = imread(path, cv2.IMREAD_UNCHANGED)
            if img is not None:
                if img.ndim == 2:
                    img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
                elif img.shape[2] == 3:
                    img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
                return img
            log.warning("Mask image %s could not be read; using the built-in mask.", path)
        return _builtin_mask()

    # ------------------------------------------------------------------
    @staticmethod
    def face_shape(geom: np.ndarray, cfg: AnonymizeConfig) -> tuple[float, float, float, float, float]:
        """Core anonymization shape ``(cx, cy, half_w, half_h, angle)`` in the face's own frame.

        Coverage 0 % is the face oval itself: the ellipse inscribed in the
        detector's face box, enlarged by the face's margin (about 11 % for an
        aligned face, up to 26 % for a face tilted inside its box), so eyes,
        brows, nose, mouth, cheeks and chin are always inside. Coverage grows it toward the
        whole head (hairline, ears). The ellipse is rotated with the face, so a
        tilted head gets a tilted ellipse instead of a large upright one.
        """
        cx, cy, w, h, ang = (float(v) for v in geom[:5])
        margin = float(geom[5]) if len(geom) > 5 else DEFAULT_MARGIN
        cov = min(1.0, max(0.0, cfg.padding))
        if cfg.shape == Shape.ELLIPSE:
            hw, hh = w / 2 * (margin + cov), h / 2 * (margin + cov)
        else:
            # A rectangle reaches the box corners; tilt inside the box needs less extra.
            hw, hh = w / 2 * (1.0 + (margin - 1.0) * 0.6 + cov), h / 2 * (1.0 + (margin - 1.0) * 0.6 + cov)
        # Detector boxes stop near the brows: bias toward the forehead, more so
        # as coverage extends to the hairline.
        shift = h * (0.03 + 0.08 * cov)
        rad = math.radians(ang)
        cx += math.sin(rad) * shift
        cy -= math.cos(rad) * shift
        return cx, cy, hw, hh, ang

    @staticmethod
    def _draw(mask: np.ndarray, shape: tuple[float, float, float, float, float], ellipse: bool, value: float) -> None:
        cx, cy, hw, hh, ang = shape
        if ellipse:
            cv2.ellipse(
                mask, (int(round(cx * 16)), int(round(cy * 16))), (max(1, int(hw * 16)), max(1, int(hh * 16))),
                ang, 0, 360, value, -1, cv2.LINE_AA, 4,
            )
        else:
            pts = cv2.boxPoints(((cx, cy), (2 * hw, 2 * hh), ang))
            cv2.fillConvexPoly(mask, np.round(pts * 16).astype(np.int32), value, cv2.LINE_AA, 4)

    @staticmethod
    def as_geom(region: np.ndarray) -> np.ndarray:
        region = np.asarray(region, np.float32)
        return region if region.shape[0] >= 5 else geom_from_bbox(region)

    @classmethod
    def dedupe(cls, regions: list[np.ndarray]) -> list[np.ndarray]:
        """Drop near-duplicate regions of the same face (held + re-detected,
        upright + rotated pass), keeping the larger one, so one face is never
        drawn as several overlapping blur patches."""
        geoms = sorted((cls.as_geom(r) for r in regions), key=lambda g: -(g[2] * g[3]))
        kept: list[np.ndarray] = []
        for g in geoms:
            dup = False
            for k in kept:
                dist = math.hypot(g[0] - k[0], g[1] - k[1])
                if dist < 0.4 * min(k[2], k[3]) and g[2] * g[3] >= 0.25 * k[2] * k[3]:
                    dup = True
                    break
            if not dup:
                kept.append(g)
        return kept

    def _effect(self, roi: np.ndarray, cfg: AnonymizeConfig) -> np.ndarray:
        h, w = roi.shape[:2]
        strength = np.clip(cfg.intensity, 1, 100) / 100.0
        if cfg.style == Style.GAUSSIAN:
            # Blur a 1/4-scale copy: equivalent look at ~1/16 the cost for big faces.
            scale = 4 if min(w, h) >= 48 else 1
            small = cv2.resize(roi, (max(1, w // scale), max(1, h // scale)), interpolation=cv2.INTER_AREA)
            k = int(min(small.shape[:2]) * (0.2 + 0.8 * strength)) | 1
            k = max(3, k)
            sigma = k / 2.5
            small = cv2.GaussianBlur(small, (k, k), sigma)
            small = cv2.GaussianBlur(small, (k, k), sigma)  # 2 passes removes residual edges
            return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
        if cfg.style == Style.PIXELATE:
            blocks = int(round(24 - 20 * strength))  # 24 blocks (light) .. 4 blocks (strong)
            bw = max(2, blocks)
            bh = max(2, int(round(bw * h / max(w, 1))))
            small = cv2.resize(roi, (bw, bh), interpolation=cv2.INTER_AREA)
            return cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
        if cfg.style == Style.BLACK_BOX:
            out = np.empty_like(roi)
            out[:] = cfg.box_color
            return out
        # Custom mask: alpha-composite the PNG over a pixelated base so that any
        # transparent pixels in the artwork never reveal the face underneath.
        base = cv2.resize(cv2.resize(roi, (4, 4), interpolation=cv2.INTER_AREA), (w, h), interpolation=cv2.INTER_NEAREST)
        mask = self._mask_bgra if self._mask_bgra is not None else _builtin_mask()
        m = cv2.resize(mask, (w, h), interpolation=cv2.INTER_AREA)
        a = m[..., 3:4].astype(np.float32) / 255.0
        return (m[..., :3].astype(np.float32) * a + base.astype(np.float32) * (1 - a)).astype(np.uint8)

    def apply(self, frame: np.ndarray, regions: list[np.ndarray]) -> None:
        """Anonymize ``regions`` in-place. Each region is an oriented face
        geometry ``[cx, cy, w, h, angle]`` or an upright ``[x1, y1, x2, y2]`` box."""
        fh, fw = frame.shape[:2]
        with self._lock:
            cfg = self.cfg
            ellipse = cfg.shape == Shape.ELLIPSE
            for geom in self.dedupe(regions):
                core = self.face_shape(geom, cfg)
                cx, cy, hw, hh, ang = core
                band = 0.12 * min(hw, hh) if cfg.feather else 0.0
                outer = (cx, cy, hw + band, hh + band, ang)
                # Axis-aligned extent of the (rotated) outer shape, plus blur margin.
                c, sn = abs(math.cos(math.radians(ang))), abs(math.sin(math.radians(ang)))
                ex = (hw + band) * c + (hh + band) * sn if not ellipse else math.hypot((hw + band) * c, (hh + band) * sn)
                ey = (hw + band) * sn + (hh + band) * c if not ellipse else math.hypot((hw + band) * sn, (hh + band) * c)
                pad = int(band) + 2
                gx1, gy1 = int(math.floor(cx - ex)) - pad, int(math.floor(cy - ey)) - pad
                gx2, gy2 = int(math.ceil(cx + ex)) + pad, int(math.ceil(cy + ey)) + pad
                x1, y1, x2, y2 = max(0, gx1), max(0, gy1), min(fw, gx2), min(fh, gy2)
                if x2 - x1 < 1 or y2 - y1 < 1:
                    continue
                # Mask in ROI coordinates; the full shape is drawn even when the
                # frame border cuts the face, so its geometry never shrinks.
                mask = np.zeros((y2 - y1, x2 - x1), np.float32)
                shift = lambda sh: (sh[0] - x1, sh[1] - y1, sh[2], sh[3], sh[4])  # noqa: E731
                if band > 0:
                    self._draw(mask, shift(outer), ellipse, 1.0)
                    k = max(3, int(band) | 1)
                    mask = cv2.GaussianBlur(mask, (k, k), band / 3.0)
                    core_mask = np.zeros_like(mask)
                    self._draw(core_mask, shift(core), ellipse, 1.0)
                    np.maximum(mask, core_mask, out=mask)
                else:
                    self._draw(mask, shift(core), ellipse, 1.0)
                roi = frame[y1:y2, x1:x2]
                effect = self._effect(roi, cfg)
                roi[:] = cv2.blendLinear(effect, roi, mask, 1.0 - mask)
