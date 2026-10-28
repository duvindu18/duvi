"""Phone camera receiver UI: Blackmagic Camera (or any RTMP/SRT app) -> Veil."""

from __future__ import annotations

import logging

from PySide6.QtCore import QObject, QRectF, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QGuiApplication, QPainter
from PySide6.QtWidgets import QComboBox, QDialog, QGridLayout, QHBoxLayout, QLineEdit, QVBoxLayout, QWidget

from app.core import mediamtx
from app.gui.icons import make_icon
from app.gui.tasks import run_task
from app.gui.theme import P
from app.gui.widgets import Chip, EmberBackground, GlassCard, button, label, two_tone

log = logging.getLogger(__name__)


class PhoneReceiver(QObject):
    """Owns the MediaMTX process and polls the stream state once a second."""

    statusChanged = Signal(object)  # StreamStatus | None
    started = Signal()
    failed = Signal(str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.server = mediamtx.MediaMTXServer()
        self.status: mediamtx.StreamStatus | None = None
        self._starting = False
        self._polling = False
        self._timer = QTimer(self)
        self._timer.setInterval(1000)
        self._timer.timeout.connect(self._poll)

    @property
    def available(self) -> bool:
        return self.server.available

    @property
    def running(self) -> bool:
        return self.server.running

    @property
    def ready(self) -> bool:
        return bool(self.status and self.status.ready)

    def start(self) -> None:
        if self.server.running or self._starting:
            return
        self._starting = True

        def done(_r) -> None:
            self._starting = False
            self._timer.start()
            self.started.emit()
            self._poll()

        def fail(msg: str) -> None:
            self._starting = False
            self.failed.emit(msg)

        run_task(self.server.start, on_done=done, on_error=fail)

    def stop(self) -> None:
        self._timer.stop()
        self.server.stop()
        self.status = None
        self.statusChanged.emit(None)

    def _poll(self) -> None:
        if self._polling:
            return
        self._polling = True

        def done(st) -> None:
            self._polling = False
            self.status = st
            self.statusChanged.emit(st)

        def fail(_m: str) -> None:
            self._polling = False

        run_task(self.server.status, on_done=done, on_error=fail)


def describe(status: mediamtx.StreamStatus | None, running: bool) -> tuple[str, str]:
    """(text, dot colour) for the current receiver state."""
    if not running:
        return "Receiver off", P.text_faint
    if status is None or not status.ready:
        return "Waiting for the phone to start streaming…", P.warn
    proto = {"rtmpConn": "RTMP", "srtConn": "SRT"}.get(status.source, status.source or "stream")
    return f"Receiving · {proto} · {' + '.join(status.tracks) or 'video'}", P.ok


class QrCode(QWidget):
    def __init__(self, text: str = "", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setFixedSize(188, 188)
        self._matrix: list[list[bool]] = []
        self.set_text(text)

    def set_text(self, text: str) -> None:
        try:
            import qrcode

            qr = qrcode.QRCode(border=2, error_correction=qrcode.constants.ERROR_CORRECT_M)
            qr.add_data(text)
            qr.make(fit=True)
            self._matrix = qr.get_matrix()
        except Exception as exc:  # qrcode missing: the URLs are still shown as text
            log.debug("QR unavailable: %s", exc)
            self._matrix = []
        self.update()

    def paintEvent(self, _e) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor("white"))
        p.drawRoundedRect(QRectF(self.rect()), 16, 16)
        if not self._matrix:
            return
        n = len(self._matrix)
        cell = (self.width() - 16) / n
        p.setBrush(QColor("#2A0D07"))
        for y, row in enumerate(self._matrix):
            for x, on in enumerate(row):
                if on:
                    p.drawRect(QRectF(8 + x * cell, 8 + y * cell, cell + 0.4, cell + 0.4))


class PhoneDialog(QDialog):
    """Step-by-step connection guide with copyable URLs and a QR code."""

    startPreview = Signal()

    def __init__(self, receiver: PhoneReceiver, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.receiver = receiver
        self.setWindowTitle("Connect a phone camera")
        self.setMinimumSize(820, 600)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        bg = EmberBackground()
        outer.addWidget(bg)
        root = QVBoxLayout(bg)
        root.setContentsMargins(28, 24, 28, 24)
        root.setSpacing(14)
        root.addWidget(label(two_tone("Connect your", "phone camera"), "title"))
        root.addWidget(
            label(
                "Blackmagic Camera (or Larix, OBS, any RTMP/SRT app) streams over Wi-Fi to Veil's built-in "
                "receiver. Phone and PC must be on the same network.",
                "dim",
                wrap=True,
            )
        )

        body = QHBoxLayout()
        body.setSpacing(18)
        left = GlassCard("1 · Enter these in the app")
        grid = QGridLayout()
        grid.setHorizontalSpacing(10)
        grid.setVerticalSpacing(10)
        self.ip_combo = QComboBox()
        ips = mediamtx.local_ipv4_addresses() or ["127.0.0.1"]
        self.ip_combo.addItems(ips)
        self.ip_combo.setToolTip("This PC's address on your network. Pick the Wi-Fi/Ethernet one the phone uses.")
        grid.addWidget(label("PC address", "caption"), 0, 0)
        grid.addWidget(self.ip_combo, 0, 1, 1, 2)
        self.fields: dict[str, QLineEdit] = {}
        for row, (key, title) in enumerate(
            (("rtmp_server", "Server URL"), ("rtmp_key", "Stream key"), ("rtmp_full", "Full RTMP URL"), ("srt", "SRT URL (alternative)")),
            start=1,
        ):
            edit = QLineEdit()
            edit.setReadOnly(True)
            self.fields[key] = edit
            copy = button("Copy", on_click=lambda _=False, e=edit: self._copy(e))
            grid.addWidget(label(title, "caption"), row, 0)
            grid.addWidget(edit, row, 1)
            grid.addWidget(copy, row, 2)
        grid.setColumnStretch(1, 1)
        left.body.addLayout(grid)
        left.body.addWidget(label("2 · In Blackmagic Camera", "h2"))
        left.body.addWidget(
            label(
                "Open Settings (gear) → Stream (live streaming) → choose a custom RTMP server / "
                "'Custom' platform → paste the Server URL and Stream key above → go back and tap "
                "the stream / live button. Menu names vary slightly between app versions; any app "
                "that accepts a custom RTMP URL works the same way.",
                "dim",
                wrap=True,
            )
        )
        left.body.addWidget(
            label(
                "Tip: 1080p30 at 6-10 Mbps with a 1-second keyframe interval gives the lowest delay "
                "(about 0.5-1.5 s). Windows may ask to allow 'mediamtx' through the firewall - choose "
                "Private networks.",
                "faint",
                wrap=True,
            )
        )
        body.addWidget(left, 3)

        right = GlassCard("Scan on the phone")
        self.qr = QrCode()
        right.body.addWidget(self.qr, 0, Qt.AlignmentFlag.AlignHCenter)
        right.body.addWidget(label("Contains the full RTMP URL", "faint"), 0, Qt.AlignmentFlag.AlignHCenter)
        right.body.addStretch(1)
        self.status_chip = Chip("Receiver off", dot=P.text_faint)
        right.body.addWidget(self.status_chip, 0, Qt.AlignmentFlag.AlignHCenter)
        body.addWidget(right, 2)
        root.addLayout(body, 1)

        actions = QHBoxLayout()
        actions.addStretch(1)
        actions.addWidget(button("Close", on_click=self.reject))
        self.start_btn = button("Start anonymized preview", "primary", make_icon("play", 16, P.text_on_light), self._start)
        actions.addWidget(self.start_btn)
        root.addLayout(actions)

        self.ip_combo.currentTextChanged.connect(self._fill)
        receiver.statusChanged.connect(self._on_status)
        receiver.started.connect(lambda: self._on_status(receiver.status))
        self._fill(self.ip_combo.currentText())
        self._on_status(receiver.status)
        if receiver.available:
            receiver.start()

    def _fill(self, ip: str) -> None:
        urls = mediamtx.publish_urls(ip)
        for key, edit in self.fields.items():
            edit.setText(urls[key])
        self.qr.set_text(urls["rtmp_full"])

    @staticmethod
    def _copy(edit: QLineEdit) -> None:
        QGuiApplication.clipboard().setText(edit.text())

    def _on_status(self, status) -> None:
        text, dot = describe(status, self.receiver.running)
        if not self.receiver.available:
            text, dot = "MediaMTX not installed - re-run setup", P.danger
        self.status_chip.setText(text)
        self.status_chip.set_dot(dot)
        self.status_chip.adjustSize()
        self.start_btn.setEnabled(self.receiver.ready)

    def _start(self) -> None:
        self.accept()
        self.startPreview.emit()
