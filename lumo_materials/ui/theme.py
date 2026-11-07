"""Flat, pure-dark theme (from the approved homepage design) and font loading."""
from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtGui import QColor, QFont, QFontDatabase, QPalette
from PySide6.QtWidgets import QApplication

# ---- colours ------------------------------------------------------------------------------------
WIN = "#0d0d0e"        # sidebar, inspector
MAIN = "#131314"       # main pane
CARD = "#18181a"
CARD_2 = "#1c1c1e"
HOVER = "#1f1f21"
ROW = "#161618"        # fill-bar rows
FILL = "#2a2a2d"       # fill of fill-bar rows
LINE = "#242426"
LINE_2 = "#2c2c2f"
TEXT = "#ececee"
TEXT_2 = "#b4b4b8"
MUTED = "#86868c"
FAINT = "#5a5a60"
ACCENT = "#ececee"     # primary buttons are light on dark
STAR = "#e6c14a"
DANGER = "#e5484d"
CLOSE_HOVER = "#c42b1c"
OK = "#4cc38a"

CATEGORY_COLOURS = ["#3b6fd8", "#b07a45", "#6b6b70", "#9aa3ad", "#d96b3b", "#d9c24a", "#5f9a45",
                    "#8e5cd9", "#3aa6a6", "#c4566e", "#7d8b3a", "#5a7bd0"]

RADIUS = 9
FONT_FAMILY = "Inter"


def category_colour(name: str, index: int | None = None) -> str:
    if index is None:
        index = sum(ord(c) for c in name)
    return CATEGORY_COLOURS[index % len(CATEGORY_COLOURS)]


def asset_dir() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    p = base / "assets"
    if p.is_dir():
        return p
    return Path(__file__).resolve().parents[1] / "assets"


def load_fonts() -> str:
    """Registers the bundled Inter fonts; falls back to Segoe UI if they are missing."""
    family = None
    fdir = asset_dir() / "fonts"
    if fdir.is_dir():
        for f in sorted(fdir.glob("*.otf")) + sorted(fdir.glob("*.ttf")):
            fid = QFontDatabase.addApplicationFont(str(f))
            if fid >= 0 and family is None:
                fams = QFontDatabase.applicationFontFamilies(fid)
                if fams:
                    family = fams[0]
    if family is None:
        family = "Segoe UI" if sys.platform == "win32" else "Sans Serif"
    global FONT_FAMILY
    FONT_FAMILY = family
    return family


def qss() -> str:
    f = FONT_FAMILY
    return f"""
* {{ font-family: "{f}"; font-size: 13px; color: {TEXT}; outline: 0; }}
QWidget#Root {{ background: {MAIN}; }}
QWidget#Sidebar, QWidget#Inspector {{ background: {WIN}; }}
QWidget#Main, QStackedWidget#Pages, QWidget#Page {{ background: {MAIN}; }}
QFrame#VLine {{ background: {LINE}; max-width: 1px; min-width: 1px; }}
QFrame#HLine {{ background: {LINE}; max-height: 1px; min-height: 1px; }}
QWidget#Header {{ background: transparent; border-bottom: 1px solid {LINE}; }}

QLabel {{ background: transparent; }}
QLabel[role="title"] {{ font-size: 20px; font-weight: 500; }}
QLabel[role="h2"] {{ font-size: 14px; font-weight: 500; }}
QLabel[role="muted"] {{ color: {MUTED}; }}
QLabel[role="faint"] {{ color: {FAINT}; font-size: 11px; }}
QLabel[role="section"] {{ color: {FAINT}; font-size: 11px; font-weight: 600; letter-spacing: 0.4px; }}
QLabel[role="crumb"] {{ color: {TEXT_2}; font-size: 14px; }}
QLabel[role="crumbNow"] {{ color: {TEXT}; font-size: 14px; }}
QLabel[role="kbd"] {{ color: {MUTED}; font-size: 11px; border: 1px solid {LINE_2}; border-radius: 5px;
                      padding: 0px 6px; background: #151517; }}
QLabel[role="badge"] {{ color: {MUTED}; font-size: 10px; font-weight: 600; border: 1px solid {LINE_2};
                        border-radius: 5px; padding: 1px 5px; background: #141416; }}
QLabel[role="error"] {{ color: {DANGER}; }}

QPushButton {{ background: #1e1e20; border: 1px solid {LINE_2}; border-radius: 7px; padding: 0px 12px;
               min-height: 30px; font-weight: 500; }}
QPushButton:hover {{ background: #252528; }}
QPushButton:pressed {{ background: #2a2a2d; }}
QPushButton:disabled {{ color: {FAINT}; background: #171719; }}
QPushButton[kind="primary"] {{ background: {ACCENT}; color: #111113; border-color: {ACCENT}; }}
QPushButton[kind="primary"]:hover {{ background: #ffffff; }}
QPushButton[kind="primary"]:disabled {{ background: #3a3a3e; color: #77777c; border-color: #3a3a3e; }}
QPushButton[kind="ghost"] {{ background: transparent; }}
QPushButton[kind="ghost"]:hover {{ background: {HOVER}; }}
QPushButton[kind="danger"] {{ color: {DANGER}; }}
QPushButton[kind="nav"] {{ background: transparent; border: 1px solid transparent; text-align: left;
                           padding: 0px 10px; min-height: 30px; color: {TEXT_2}; font-weight: 400; }}
QPushButton[kind="nav"]:hover {{ background: {HOVER}; }}
QPushButton[kind="nav"]:checked {{ background: {CARD_2}; border-color: {LINE_2}; color: {TEXT}; }}
QPushButton[kind="pill"] {{ min-height: 26px; padding: 0px 10px; border-radius: 7px; background: transparent;
                            color: {TEXT_2}; font-size: 12px; font-weight: 400; }}
QPushButton[kind="pill"]:hover {{ background: {HOVER}; }}
QPushButton[kind="pill"]:checked {{ background: {ACCENT}; color: #111113; border-color: {ACCENT}; font-weight: 500; }}
QPushButton[kind="square"] {{ min-width: 26px; max-width: 26px; min-height: 26px; max-height: 26px; padding: 0px;
                              border-radius: 6px; }}
QPushButton[kind="page"] {{ min-width: 26px; max-width: 26px; min-height: 26px; padding: 0px; border: none;
                            background: transparent; color: {MUTED}; font-size: 12px; font-weight: 400; }}
QPushButton[kind="page"]:checked {{ color: {TEXT}; background: {CARD_2}; }}
QPushButton[kind="seg"] {{ border-radius: 0px; border: none; background: transparent; min-height: 26px;
                           padding: 0px 10px; color: {MUTED}; font-size: 11px; font-weight: 400; }}
QPushButton[kind="seg"]:checked {{ background: #232326; color: {TEXT}; }}
QToolButton {{ background: transparent; border: none; border-radius: 6px; padding: 3px; }}
QToolButton:hover {{ background: {HOVER}; }}

QLineEdit, QPlainTextEdit, QSpinBox, QDoubleSpinBox {{ background: #111112; border: 1px solid {LINE_2};
    border-radius: 7px; padding: 5px 10px; selection-background-color: #3a3a40; }}
QLineEdit {{ min-height: 20px; }}
QLineEdit:focus, QPlainTextEdit:focus {{ border-color: #4a4a50; }}
QLineEdit[role="search"] {{ border: none; background: transparent; padding: 0px; }}

QComboBox {{ background: #1e1e20; border: 1px solid {LINE_2}; border-radius: 7px; padding: 0px 10px;
             min-height: 30px; }}
QComboBox:hover {{ background: #252528; }}
QComboBox::drop-down {{ border: none; width: 22px; }}
QComboBox QAbstractItemView {{ background: #18181a; border: 1px solid {LINE_2}; selection-background-color: #2a2a2e;
                               padding: 4px; }}
QMenu {{ background: #18181a; border: 1px solid {LINE_2}; border-radius: 8px; padding: 4px; }}
QMenu::item {{ padding: 6px 22px 6px 12px; border-radius: 5px; }}
QMenu::item:selected {{ background: #2a2a2e; }}
QMenu::separator {{ height: 1px; background: {LINE}; margin: 4px 6px; }}

QCheckBox {{ spacing: 8px; }}
QCheckBox::indicator {{ width: 14px; height: 14px; border: 1.5px solid #4a4a50; border-radius: 4px; background: transparent; }}
QCheckBox::indicator:checked {{ background: {ACCENT}; border-color: {ACCENT}; }}

QScrollArea {{ background: transparent; border: none; }}
QScrollArea > QWidget > QWidget {{ background: transparent; }}
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 2px; }}
QScrollBar::handle:vertical {{ background: #2c2c30; border-radius: 3px; min-height: 30px; }}
QScrollBar::handle:vertical:hover {{ background: #3a3a3f; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; margin: 2px; }}
QScrollBar::handle:horizontal {{ background: #2c2c30; border-radius: 3px; min-width: 30px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; height: 0; }}
QScrollBar::add-page, QScrollBar::sub-page {{ background: transparent; }}

QListView, QTreeView, QTableWidget {{ background: transparent; border: none; }}
QTableWidget {{ gridline-color: {LINE}; }}
QHeaderView::section {{ background: transparent; color: {FAINT}; border: none; border-bottom: 1px solid {LINE};
                        padding: 6px 8px; font-size: 11px; font-weight: 600; }}
QTableWidget::item {{ padding: 4px 8px; border-bottom: 1px solid {LINE}; }}
QToolTip {{ background: #1c1c1e; color: {TEXT}; border: 1px solid {LINE_2}; padding: 4px 8px; border-radius: 6px; }}
QProgressBar {{ background: {ROW}; border: none; border-radius: 3px; max-height: 6px; min-height: 6px; text-align: center; }}
QProgressBar::chunk {{ background: {ACCENT}; border-radius: 3px; }}
QFrame#Card {{ background: {CARD}; border: 1px solid {LINE}; border-radius: 10px; }}
QFrame#Panel {{ background: #111112; border: 1px solid {LINE_2}; border-radius: 10px; }}
QFrame#Toast {{ background: #1c1c1e; border: 1px solid {LINE_2}; border-radius: 9px; }}
QWidget#DropOverlay {{ background: rgba(13,13,14,215); border: 2px dashed #4a4a50; border-radius: 14px; }}
"""


def apply(app: QApplication) -> None:
    family = load_fonts()
    font = QFont(family, 10)
    font.setPixelSize(13)
    font.setHintingPreference(QFont.HintingPreference.PreferNoHinting)
    app.setFont(font)
    pal = QPalette()
    for role, col in ((QPalette.ColorRole.Window, MAIN), (QPalette.ColorRole.Base, "#111112"),
                      (QPalette.ColorRole.AlternateBase, CARD), (QPalette.ColorRole.Text, TEXT),
                      (QPalette.ColorRole.WindowText, TEXT), (QPalette.ColorRole.Button, "#1e1e20"),
                      (QPalette.ColorRole.ButtonText, TEXT), (QPalette.ColorRole.Highlight, "#3a3a40"),
                      (QPalette.ColorRole.HighlightedText, TEXT), (QPalette.ColorRole.ToolTipBase, CARD_2),
                      (QPalette.ColorRole.ToolTipText, TEXT), (QPalette.ColorRole.PlaceholderText, FAINT)):
        pal.setColor(role, QColor(col))
    app.setPalette(pal)
    app.setStyleSheet(qss())


def restyle(widget) -> None:
    """Re-applies the style after a dynamic property changed."""
    widget.style().unpolish(widget)
    widget.style().polish(widget)
    widget.update()
