"""Line icons (16 x 16 grid, 1.5 px stroke) drawn as SVG and tinted at run time."""
from __future__ import annotations

from functools import lru_cache

from PySide6.QtCore import QByteArray, QRectF, QSize, Qt
from PySide6.QtGui import QIcon, QImage, QPainter, QPixmap
from PySide6.QtSvg import QSvgRenderer

_P = {
    "search": '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
    "photo": '<rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="6" cy="6.5" r="1.2"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/>',
    "import": '<path d="M8 2v8M5 7l3 3 3-3M3 12.5v.5a1 1 0 001 1h8a1 1 0 001-1v-.5"/>',
    "grid": '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
    "list": '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
    "star": '<path d="M8 2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.2l-3.6 1.9.7-4L2.2 6.3l4-.6z"/>',
    "star-fill": '<path fill="currentColor" d="M8 2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.2l-3.6 1.9.7-4L2.2 6.3l4-.6z"/>',
    "clock": '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
    "file": '<path d="M4 2h5l3 3v8.5a.5.5 0 01-.5.5h-7.5a.5.5 0 01-.5-.5v-11A.5.5 0 014 2z"/><path d="M9 2v3h3M6 8.5h4M6 11h4"/>',
    "trash": '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5a1 1 0 001 1h3.8a1 1 0 001-1l.6-8.5"/>',
    "gear": '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
    "chev-ud": '<path d="M5.5 6L8 3.5 10.5 6M5.5 10L8 12.5 10.5 10"/>',
    "caret": '<path d="M5 6.5l3 3 3-3"/>',
    "plus-folder": '<path d="M2.5 4.5a1 1 0 011-1h3l1.5 1.5h4.5a1 1 0 011 1v6a1 1 0 01-1 1h-9a1 1 0 01-1-1z"/><path d="M8 7v4M6 9h4"/>',
    "drop": '<rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke-dasharray="2 2"/><path d="M8 5.5v5M5.5 8h5"/>',
    "refresh": '<path d="M13 8a5 5 0 11-1.5-3.6M13 2.5v2.5h-2.5"/>',
    "sort": '<path d="M3 4.5h10M5 8h6M7 11.5h2"/>',
    "more": '<circle cx="4" cy="8" r=".7" fill="currentColor"/><circle cx="8" cy="8" r=".7" fill="currentColor"/><circle cx="12" cy="8" r=".7" fill="currentColor"/>',
    "first": '<path d="M8.5 4.5L5 8l3.5 3.5M12 4.5L8.5 8l3.5 3.5"/>',
    "prev": '<path d="M9.5 4.5L6 8l3.5 3.5"/>',
    "next": '<path d="M6.5 4.5L10 8l-3.5 3.5"/>',
    "last": '<path d="M4 4.5L7.5 8 4 11.5M7.5 4.5L11 8l-3.5 3.5"/>',
    "check": '<path d="M3.5 8.5l3 3 6-7"/>',
    "export": '<path d="M8 10V2M5 5l3-3 3 3M3 9.5V13a1 1 0 001 1h8a1 1 0 001-1V9.5"/>',
    "sliders": '<path d="M3 4h6M12 4h1M3 12h1M7 12h6M3 8h3M9 8h4"/><circle cx="10.5" cy="4" r="1.5"/><circle cx="5.5" cy="12" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/>',
    "folder": '<path d="M2.5 4.5a1 1 0 011-1h3l1.5 1.5h4.5a1 1 0 011 1v6a1 1 0 01-1 1h-9a1 1 0 01-1-1z"/>',
    "copy": '<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5"/>',
    "edit": '<path d="M10.5 3l2.5 2.5L6 12.5 3 13l.5-3z"/>',
    "tag": '<path d="M2.5 8.2V3.5a1 1 0 011-1h4.7l5.3 5.3-5.7 5.7z"/><circle cx="5.5" cy="5.5" r=".8" fill="currentColor"/>',
    "restore": '<path d="M3 8a5 5 0 105-5H5M5 1l-2 2 2 2"/>',
    "close": '<path d="M4 4l8 8M12 4l-8 8"/>',
    "regen": '<path d="M2.5 8a5.5 5.5 0 019.4-3.9M13.5 8a5.5 5.5 0 01-9.4 3.9M12 1.5v2.8H9.2M4 14.5v-2.8h2.8"/>',
    "image-stack": '<rect x="4" y="4" width="10" height="9" rx="1.5"/><path d="M2 11V3.5A1.5 1.5 0 013.5 2H11"/>',
    "reveal": '<path d="M2.5 4.5a1 1 0 011-1h3l1.5 1.5h4.5a1 1 0 011 1v6a1 1 0 01-1 1h-9a1 1 0 01-1-1z"/><path d="M8 7.5v3M6.5 9l1.5 1.5L9.5 9"/>',
    "warning": '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.3v.2"/>',
    "info": '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5v3.5M8 5v.2"/>',
}


def svg(name: str, color: str = "#ececee", stroke: float = 1.5) -> bytes:
    body = _P[name].replace("currentColor", color)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="{color}" '
            f'stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round">{body}</svg>').encode()


@lru_cache(maxsize=512)
def pixmap(name: str, color: str = "#ececee", size: int = 16, dpr: float = 2.0, stroke: float = 1.5) -> QPixmap:
    r = QSvgRenderer(QByteArray(svg(name, color, stroke)))
    px = int(round(size * dpr))
    img = QImage(px, px, QImage.Format.Format_ARGB32_Premultiplied)
    img.fill(Qt.GlobalColor.transparent)
    p = QPainter(img)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    r.render(p, QRectF(0, 0, px, px))
    p.end()
    pm = QPixmap.fromImage(img)
    pm.setDevicePixelRatio(dpr)
    return pm


def icon(name: str, color: str = "#b4b4b8", active: str | None = None, size: int = 16) -> QIcon:
    ic = QIcon()
    ic.addPixmap(pixmap(name, color, size), QIcon.Mode.Normal, QIcon.State.Off)
    ic.addPixmap(pixmap(name, active or "#ececee", size), QIcon.Mode.Normal, QIcon.State.On)
    ic.addPixmap(pixmap(name, active or "#ececee", size), QIcon.Mode.Active, QIcon.State.Off)
    ic.addPixmap(pixmap(name, "#5a5a60", size), QIcon.Mode.Disabled, QIcon.State.Off)
    return ic


ICON_SIZE = QSize(16, 16)
