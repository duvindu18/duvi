"""Dependency-free SCRFD detector and ArcFace recognizer on ONNX Runtime.

These run the InsightFace ``buffalo_*`` model files directly, so the app does
not need the ``insightface`` pip package. That package must be compiled with a
C++ toolchain on Windows and pulls in a second OpenCV build. The pre- and
post-processing reproduces ``insightface.model_zoo.scrfd`` and ``arcface_onnx``
from release 0.7.3.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import cv2
import numpy as np

log = logging.getLogger(__name__)


def make_session(path: Path, providers: list[str], provider_options: list[dict[str, Any]], threads: int = 0):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    if threads > 0:
        opts.intra_op_num_threads = threads
    opts.log_severity_level = 3
    return ort.InferenceSession(str(path), sess_options=opts, providers=providers, provider_options=provider_options)


def _nms(dets: np.ndarray, thresh: float) -> list[int]:
    x1, y1, x2, y2, scores = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0.0, xx2 - xx1 + 1) * np.maximum(0.0, yy2 - yy1 + 1)
        ovr = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[np.where(ovr <= thresh)[0] + 1]
    return keep


class SCRFD:
    """SCRFD face detector (``det_10g.onnx`` / ``det_500m.onnx``)."""

    nms_threshold = 0.4
    input_mean = 127.5
    input_std = 128.0

    def __init__(self, session, input_size: int = 640) -> None:
        self.session = session
        inp = session.get_inputs()[0]
        self.input_name = inp.name
        self.output_names = [o.name for o in session.get_outputs()]
        shape = inp.shape
        # Fixed-shape exports dictate the input size; dynamic ones use the setting.
        self.dynamic = not (isinstance(shape[2], int) and isinstance(shape[3], int))
        if self.dynamic:
            self.input_size = (input_size, input_size)
        else:
            self.input_size = (int(shape[3]), int(shape[2]))
        outputs = session.get_outputs()
        self.batched = len(outputs[0].shape) == 3
        n = len(outputs)
        if n == 6:
            self.fmc, self.strides, self.num_anchors, self.use_kps = 3, [8, 16, 32], 2, False
        elif n == 9:
            self.fmc, self.strides, self.num_anchors, self.use_kps = 3, [8, 16, 32], 2, True
        elif n == 10:
            self.fmc, self.strides, self.num_anchors, self.use_kps = 5, [8, 16, 32, 64, 128], 1, False
        elif n == 15:
            self.fmc, self.strides, self.num_anchors, self.use_kps = 5, [8, 16, 32, 64, 128], 1, True
        else:
            raise ValueError(f"Unsupported SCRFD model with {n} outputs")
        self._centers: dict[tuple[int, int, int], np.ndarray] = {}

    def _anchor_centers(self, h: int, w: int, stride: int) -> np.ndarray:
        key = (h, w, stride)
        centers = self._centers.get(key)
        if centers is None:
            centers = np.stack(np.mgrid[:h, :w][::-1], axis=-1).astype(np.float32)
            centers = (centers * stride).reshape(-1, 2)
            if self.num_anchors > 1:
                centers = np.stack([centers] * self.num_anchors, axis=1).reshape(-1, 2)
            if len(self._centers) < 100:
                self._centers[key] = centers
        return centers

    def detect(
        self, img: np.ndarray, threshold: float, input_size: tuple[int, int] | None = None
    ) -> tuple[np.ndarray, np.ndarray | None]:
        """Returns ``(N,5)`` boxes+scores and ``(N,5,2)`` landmarks in image pixels.

        ``input_size`` overrides the network resolution (dynamic-shape models only).
        """
        in_w, in_h = input_size if (input_size and self.dynamic) else self.input_size
        im_ratio = img.shape[0] / img.shape[1]
        if im_ratio > in_h / in_w:
            new_h = in_h
            new_w = int(new_h / im_ratio)
        else:
            new_w = in_w
            new_h = int(new_w * im_ratio)
        scale = new_h / img.shape[0]
        canvas = np.zeros((in_h, in_w, 3), dtype=np.uint8)
        canvas[:new_h, :new_w] = cv2.resize(img, (new_w, new_h))
        blob = cv2.dnn.blobFromImage(
            canvas, 1.0 / self.input_std, (in_w, in_h), (self.input_mean,) * 3, swapRB=True
        )
        outs = self.session.run(self.output_names, {self.input_name: blob})

        scores_l, boxes_l, kps_l = [], [], []
        for idx, stride in enumerate(self.strides):
            scores = outs[idx]
            boxes = outs[idx + self.fmc]
            kps = outs[idx + self.fmc * 2] if self.use_kps else None
            if self.batched:
                scores, boxes = scores[0], boxes[0]
                kps = kps[0] if kps is not None else None
            scores = scores.reshape(-1)
            boxes = boxes * stride
            centers = self._anchor_centers(in_h // stride, in_w // stride, stride)
            pos = np.where(scores >= threshold)[0]
            if pos.size == 0:
                continue
            c = centers[pos]
            d = boxes[pos]
            scores_l.append(scores[pos])
            boxes_l.append(np.stack([c[:, 0] - d[:, 0], c[:, 1] - d[:, 1], c[:, 0] + d[:, 2], c[:, 1] + d[:, 3]], axis=-1))
            if kps is not None:
                k = kps[pos] * stride
                pts = np.empty((len(pos), k.shape[1] // 2, 2), np.float32)
                pts[..., 0] = c[:, 0:1] + k[:, 0::2]
                pts[..., 1] = c[:, 1:2] + k[:, 1::2]
                kps_l.append(pts)
        if not scores_l:
            return np.zeros((0, 5), np.float32), None
        scores = np.concatenate(scores_l)
        boxes = np.concatenate(boxes_l) / scale
        dets = np.hstack([boxes, scores[:, None]]).astype(np.float32)
        keep = _nms(dets, self.nms_threshold)
        dets = dets[keep]
        kpss = (np.concatenate(kps_l) / scale)[keep].astype(np.float32) if kps_l else None
        return dets, kpss


class ArcFace:
    """ArcFace embedding model (``w600k_r50.onnx`` / ``w600k_mbf.onnx``)."""

    input_mean = 127.5
    input_std = 127.5

    def __init__(self, session) -> None:
        self.session = session
        inp = session.get_inputs()[0]
        self.input_name = inp.name
        self.output_name = session.get_outputs()[0].name
        self.input_size = (112, 112)

    def embed(self, crops: list[np.ndarray]) -> np.ndarray:
        blob = cv2.dnn.blobFromImages(
            crops, 1.0 / self.input_std, self.input_size, (self.input_mean,) * 3, swapRB=True
        )
        return self.session.run([self.output_name], {self.input_name: blob})[0]
