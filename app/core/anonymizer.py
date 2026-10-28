"""Selective anonymization: decides *who* to hide and renders *how*.

Rendering works on a region guaranteed to contain the *entire* detected face
(see :meth:`Anonymizer._region`). Effects are
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
    def _region(bbox: np.ndarray, cfg: AnonymizeConfig) -> tuple[float, float, float, float]:
        """Unclipped effect region (x1, y1, x2, y2) that fully contains the face.

        An ellipse inscribed in a rectangle reaches the rectangle's corners only
        when its semi-axes are sqrt(2) x the half-sizes, so the ellipse shape
        scales the region by sqrt(2) before padding. Feathered edges get extra
        margin so the soft fall-off happens outside the face, never on it. The
        region is biased upwards because detector boxes stop around the brows
        and miss the forehead and hairline.
        """
        x1, y1, x2, y2 = (float(v) for v in bbox[:4])
        bw, bh = max(1.0, x2 - x1), max(1.0, y2 - y1)
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        k = 1.0 + max(0.0, cfg.padding)
        if cfg.shape == Shape.ELLIPSE:
            k *= math.sqrt(2.0) * (1.2 if cfg.feather else 1.05)
        elif cfg.feather:
            k *= 1.35  # inset + blur fall-off of the feathered rectangle
        half_w = bw / 2 * k
        half_h = bh / 2 * k + bh * 0.08
        cy -= bh * 0.08
        return cx - half_w, cy - half_h, cx + half_w, cy + half_h

    @staticmethod
    def _alpha(w: int, h: int, cfg: AnonymizeConfig) -> np.ndarray | None:
        if cfg.shape == Shape.RECTANGLE and not cfg.feather:
            return None
        alpha = np.zeros((h, w), np.float32)
        if cfg.shape == Shape.ELLIPSE:
            cv2.ellipse(alpha, (w // 2, h // 2), (max(1, w // 2 - 1), max(1, h // 2 - 1)), 0, 0, 360, 1.0, -1, cv2.LINE_AA)
        else:
            inset = max(1, min(w, h) // 14) if cfg.feather else 0
            alpha[inset : h - inset, inset : w - inset] = 1.0
        if cfg.feather:
            k = max(3, (min(w, h) // 10) | 1)
            alpha = cv2.GaussianBlur(alpha, (k, k), 0)
            # Saturate the interior so it is fully opaque; only the rim fades.
            alpha = np.clip(alpha * 2.0, 0, 1)
        return alpha[..., None]

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

    def apply(self, frame: np.ndarray, boxes: list[np.ndarray]) -> None:
        """Anonymize ``boxes`` in-place."""
        fh, fw = frame.shape[:2]
        with self._lock:
            cfg = self.cfg
            for bbox in boxes:
                rx1, ry1, rx2, ry2 = self._region(bbox, cfg)
                # The mask is built for the full (possibly off-frame) region so
                # its shape never shrinks when the frame border cuts a face.
                gx1, gy1 = int(math.floor(rx1)), int(math.floor(ry1))
                gw = max(2, int(math.ceil(rx2)) - gx1)
                gh = max(2, int(math.ceil(ry2)) - gy1)
                x1, y1 = max(0, gx1), max(0, gy1)
                x2, y2 = min(fw, gx1 + gw), min(fh, gy1 + gh)
                if x2 - x1 < 1 or y2 - y1 < 1:
                    continue
                roi = frame[y1:y2, x1:x2]
                effect = self._effect(roi, cfg)
                alpha = self._alpha(gw, gh, cfg)
                if alpha is None:
                    roi[:] = effect
                else:
                    a = alpha[y1 - gy1 : y2 - gy1, x1 - gx1 : x2 - gx1]
                    blended = effect.astype(np.float32) * a + roi.astype(np.float32) * (1.0 - a)
                    roi[:] = blended.astype(np.uint8)
