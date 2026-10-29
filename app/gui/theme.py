"""The "Ember" design system, derived from the reference mock-ups.

Warm vermilion-to-oxblood gradients, frosted-glass cards with hairline white
borders, fully rounded pills, white circular primary actions and crisp white
typography with dimmed secondary words ("Which meditation *will you choose
today?*"). Adapted for a Windows 11 dark desktop: deeper base tones so long
sessions are comfortable, Segoe UI Variable typography and 8px spacing grid.
"""

from __future__ import annotations

from dataclasses import dataclass

from PySide6.QtGui import QColor, QFont, QFontDatabase, QPalette
from PySide6.QtWidgets import QApplication


@dataclass(frozen=True)
class Palette:
    # Base gradient (top-left -> bottom-right)
    ember_hi: str = "#E2502A"
    ember: str = "#B9351B"
    ember_lo: str = "#5A170A"
    ember_deep: str = "#22080A"
    accent: str = "#FF6A3D"
    accent_soft: str = "#FF9A76"
    # Glass
    glass: str = "rgba(255, 255, 255, 0.10)"
    glass_hover: str = "rgba(255, 255, 255, 0.16)"
    glass_pressed: str = "rgba(255, 255, 255, 0.22)"
    glass_border: str = "rgba(255, 255, 255, 0.18)"
    glass_dark: str = "rgba(24, 6, 4, 0.42)"
    # Text
    text: str = "#FFFFFF"
    text_dim: str = "rgba(255, 255, 255, 0.66)"
    text_faint: str = "rgba(255, 255, 255, 0.42)"
    text_on_light: str = "#2A0D07"
    # Status
    ok: str = "#7CF5B0"
    warn: str = "#FFD36E"
    danger: str = "#FF4D4D"


P = Palette()

# Face overlay colours by role (QColor-compatible).
ROLE_COLORS = {
    "whitelist": "#FFFFFF",
    "target": "#FF6A3D",
    "known": "#FFD36E",
    "unknown": "#FF4D4D",
    "pending": "#FFB59C",
}

RADIUS_CARD = 24
RADIUS_PILL = 999
FONT_FAMILIES = ["Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI", "Inter", "Helvetica Neue", "Arial"]


def qcolor(css: str) -> QColor:
    """Parse ``#RRGGBB`` or ``rgba(r, g, b, a)`` (alpha 0..1) into a QColor."""
    css = css.strip()
    if css.startswith("rgba"):
        r, g, b, a = (float(x) for x in css[css.index("(") + 1 : css.index(")")].split(","))
        c = QColor(int(r), int(g), int(b))
        c.setAlphaF(a)
        return c
    return QColor(css)


def app_font(size: float = 10.0, weight: QFont.Weight = QFont.Weight.Normal) -> QFont:
    font = QFont()
    available = set(QFontDatabase.families())
    families = [f for f in FONT_FAMILIES if f in available] or ["Sans Serif"]
    font.setFamilies(families)
    font.setPointSizeF(size)
    font.setWeight(weight)
    font.setHintingPreference(QFont.HintingPreference.PreferNoHinting)
    return font


STYLESHEET = f"""
* {{
    color: {P.text};
    outline: none;
}}
QWidget#Root, QStackedWidget, QScrollArea, QScrollArea > QWidget > QWidget {{
    background: transparent;
}}
QToolTip {{
    background: {P.ember_deep};
    color: {P.text};
    border: 1px solid {P.glass_border};
    border-radius: 8px;
    padding: 6px 10px;
}}
QLabel[role="display"] {{ font-size: 30pt; font-weight: 300; }}
QLabel[role="title"] {{ font-size: 21pt; font-weight: 400; }}
QLabel[role="h2"] {{ font-size: 12.5pt; font-weight: 600; }}
QLabel[role="dim"] {{ color: {P.text_dim}; }}
QLabel[role="faint"] {{ color: {P.text_faint}; font-size: 8.5pt; }}
QLabel[role="caption"] {{ color: {P.text_dim}; font-size: 8.5pt; letter-spacing: 0.4px; }}
QLabel[role="value"] {{ font-size: 15pt; font-weight: 500; }}

/* ---- Inputs ------------------------------------------------------ */
QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox {{
    background: {P.glass};
    border: 1px solid {P.glass_border};
    border-radius: 20px;
    padding: 0 16px;
    min-height: 38px;  /* + 1px border top/bottom = 40px, the standard control height */
    max-height: 38px;
    selection-background-color: {P.accent};
}}
QLineEdit:focus, QComboBox:focus, QSpinBox:focus, QDoubleSpinBox:focus {{
    border: 1px solid rgba(255, 255, 255, 0.55);
    background: {P.glass_hover};
}}
QLineEdit::placeholder {{ color: {P.text_faint}; }}
QComboBox::drop-down {{ border: none; width: 28px; }}
QComboBox::down-arrow {{ image: none; width: 0; }}
QComboBox QAbstractItemView {{
    background: {P.ember_deep};
    border: 1px solid {P.glass_border};
    border-radius: 12px;
    padding: 6px;
    selection-background-color: rgba(255, 106, 61, 0.45);
}}
QSpinBox::up-button, QSpinBox::down-button,
QDoubleSpinBox::up-button, QDoubleSpinBox::down-button {{ width: 0; border: none; }}

/* ---- Buttons ----------------------------------------------------- */
QPushButton {{
    background: {P.glass};
    border: 1px solid {P.glass_border};
    border-radius: 20px;
    padding: 0 18px;
    min-height: 38px;
    max-height: 38px;
    font-weight: 500;
}}
QPushButton:hover {{ background: {P.glass_hover}; }}
QPushButton:pressed {{ background: {P.glass_pressed}; }}
QPushButton:disabled {{ color: {P.text_faint}; border-color: rgba(255,255,255,0.08); }}
QPushButton[variant="primary"] {{
    background: #FFFFFF;
    color: {P.text_on_light};
    border: 1px solid #FFFFFF;  /* keeps the same 40px outer height as other buttons */
    font-weight: 600;
}}
QPushButton[variant="primary"]:hover {{ background: #FFF1EC; }}
QPushButton[variant="primary"]:pressed {{ background: #FFD9CC; }}
QPushButton[variant="primary"]:disabled {{ background: rgba(255,255,255,0.35); color: rgba(42,13,7,0.5); }}
QPushButton[variant="danger"] {{ background: rgba(255, 77, 77, 0.22); border-color: rgba(255,77,77,0.55); }}
QPushButton[variant="pill"] {{
    min-height: 30px;
    max-height: 30px;
    border-radius: 16px;
    padding: 0 14px;
    font-size: 9pt;
    font-weight: 500;
    color: {P.text_dim};
}}
QPushButton[variant="pill"][scale="large"] {{
    min-height: 38px;  /* source picker: same 40px as the inputs beside it */
    max-height: 38px;
    border-radius: 20px;
    padding: 0 18px;
    font-size: 9.5pt;
}}
QPushButton[variant="pill"]:checked {{
    background: #FFFFFF;
    color: {P.text_on_light};
    border-color: #FFFFFF;
}}

/* ---- Scroll bars -------------------------------------------------- */
QScrollBar:vertical {{ background: transparent; width: 8px; margin: 4px 0; }}
QScrollBar::handle:vertical {{ background: rgba(255,255,255,0.22); border-radius: 4px; min-height: 32px; }}
QScrollBar::handle:vertical:hover {{ background: rgba(255,255,255,0.38); }}
QScrollBar:horizontal {{ background: transparent; height: 8px; margin: 0 4px; }}
QScrollBar::handle:horizontal {{ background: rgba(255,255,255,0.22); border-radius: 4px; min-width: 32px; }}
QScrollBar::add-line, QScrollBar::sub-line, QScrollBar::add-page, QScrollBar::sub-page {{ background: none; border: none; width: 0; height: 0; }}

/* ---- Lists / progress -------------------------------------------- */
QListWidget {{
    background: transparent;
    border: none;
}}
QListWidget::item {{
    background: {P.glass};
    border: 1px solid {P.glass_border};
    border-radius: 16px;
    padding: 10px 14px;
    margin: 3px 0;
}}
QListWidget::item:selected {{ background: {P.glass_pressed}; border-color: rgba(255,255,255,0.45); }}
QProgressBar {{
    background: {P.glass};
    border: 1px solid {P.glass_border};
    border-radius: 9px;
    min-height: 18px;
    max-height: 18px;
    text-align: center;
    font-size: 8pt;
}}
QProgressBar::chunk {{
    border-radius: 8px;
    background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 {P.accent_soft}, stop:1 #FFFFFF);
}}
QMessageBox, QInputDialog, QFileDialog, QDialog {{
    background: {P.ember_deep};
}}
QMessageBox QLabel, QInputDialog QLabel {{ color: {P.text}; }}
QMenu {{
    background: {P.ember_deep};
    border: 1px solid {P.glass_border};
    border-radius: 12px;
    padding: 6px;
}}
QMenu::item {{ padding: 8px 18px; border-radius: 8px; }}
QMenu::item:selected {{ background: rgba(255, 106, 61, 0.4); }}
"""


def apply_theme(app: QApplication) -> None:
    app.setStyle("Fusion")  # consistent rendering of QSS on every Windows version
    app.setFont(app_font(10))
    pal = QPalette()
    deep = qcolor(P.ember_deep)
    pal.setColor(QPalette.ColorRole.Window, deep)
    pal.setColor(QPalette.ColorRole.Base, deep)
    pal.setColor(QPalette.ColorRole.AlternateBase, qcolor(P.ember_lo))
    pal.setColor(QPalette.ColorRole.Text, QColor("white"))
    pal.setColor(QPalette.ColorRole.WindowText, QColor("white"))
    pal.setColor(QPalette.ColorRole.ButtonText, QColor("white"))
    pal.setColor(QPalette.ColorRole.Button, qcolor(P.ember_lo))
    pal.setColor(QPalette.ColorRole.Highlight, qcolor(P.accent))
    pal.setColor(QPalette.ColorRole.HighlightedText, QColor("white"))
    pal.setColor(QPalette.ColorRole.PlaceholderText, qcolor(P.text_faint))
    pal.setColor(QPalette.ColorRole.ToolTipBase, deep)
    pal.setColor(QPalette.ColorRole.ToolTipText, QColor("white"))
    app.setPalette(pal)
    app.setStyleSheet(STYLESHEET)
