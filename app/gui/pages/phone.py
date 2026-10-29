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
        self.setMinimumSize(860, 560)
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
        left = GlassCard("Set up Blackmagic Camera")
        ip_row = QHBoxLayout()
        ip_row.addWidget(label("This PC", "caption"))
        self.ip_combo = QComboBox()
        self.ip_combo.addItems(mediamtx.local_ipv4_addresses() or ["127.0.0.1"])
        self.ip_combo.setToolTip("This PC's address on your network. Pick the Wi-Fi/Ethernet one the phone uses.")
        ip_row.addWidget(self.ip_combo, 1)
        left.body.addLayout(ip_row)
        left.body.addWidget(
            label(
                "<b>1.</b> Scan the QR code with the phone's camera and download <b>Veil.xml</b> "
                "(or <i>Save Veil.xml…</i> and copy it to the phone).<br>"
                "<b>2.</b> In Blackmagic Camera: Settings → <b>Live Stream</b> → <b>Platform</b> → "
                "<b>Import Stream Settings</b> → choose Veil.xml.<br>"
                "<b>3.</b> Select Platform <b>Veil</b>, Server <b>Veil PC</b>, Key <b>phone</b>, "
                "Quality <b>1080p30</b>.<br>"
                "<b>4.</b> On the camera screen, start the live stream. The status turns green here.",
                "dim",
                wrap=True,
            )
        )
        tools = QHBoxLayout()
        tools.addWidget(button("Save Veil.xml…", icon=make_icon("export", 16), on_click=self._save_xml))
        self.details_btn = button("Other apps / manual setup", on_click=self._toggle_details)
        tools.addWidget(self.details_btn)
        tools.addStretch(1)
        left.body.addLayout(tools)

        # Raw URLs for Larix / OBS / Prism / any RTMP-SRT app (hidden by default).
        self.details = QWidget()
        grid = QGridLayout(self.details)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(10)
        grid.setVerticalSpacing(8)
        self.fields: dict[str, QLineEdit] = {}
        for row, (key, title) in enumerate(
            (("rtmp_server", "Server URL"), ("rtmp_key", "Stream key"), ("rtmp_full", "Full RTMP URL"), ("srt", "SRT URL"))
        ):
            edit = QLineEdit()
            edit.setReadOnly(True)
            self.fields[key] = edit
            grid.addWidget(label(title, "caption"), row, 0)
            grid.addWidget(edit, row, 1)
            grid.addWidget(button("Copy", on_click=lambda _=False, e=edit: self._copy(e)), row, 2)
        grid.setColumnStretch(1, 1)
        self.details.setVisible(False)
        left.body.addWidget(self.details)
        left.body.addStretch(1)
        body.addWidget(left, 3)

        right = GlassCard("Scan on the phone")
        self.qr = QrCode()
        right.body.addWidget(self.qr, 0, Qt.AlignmentFlag.AlignHCenter)
        self.qr_caption = label("Scan to download Veil.xml", "faint")
        right.body.addWidget(self.qr_caption, 0, Qt.AlignmentFlag.AlignHCenter)
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

        self.share = mediamtx.SettingsShareServer()
        self.finished.connect(lambda _r: self.share.stop())
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
        if self.share.start(ip):
            self.qr.set_text(mediamtx.share_url(ip))
            self.qr_caption.setText("Scan to download Veil.xml")
        else:  # port busy: fall back to the plain RTMP URL
            self.qr.set_text(urls["rtmp_full"])
            self.qr_caption.setText("Contains the full RTMP URL")

    def _toggle_details(self) -> None:
        show = not self.details.isVisible()
        self.details.setVisible(show)
        self.details_btn.setText("Hide manual setup" if show else "Other apps / manual setup")

    def _save_xml(self) -> None:
        from PySide6.QtWidgets import QFileDialog

        path, _ = QFileDialog.getSaveFileName(self, "Save Blackmagic stream settings", mediamtx.XML_NAME, "XML (*.xml)")
        if path:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(mediamtx.blackmagic_xml(self.ip_combo.currentText()))

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
