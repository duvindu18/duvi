"""The "Noir" design system: dark, flat, borderless.

Drawn from the reference designs: near-black surfaces separated by tone
rather than outlines, light large display type with tiny uppercase
letter-spaced labels, white primary actions, and a single lime accent (the
video-editor playhead) for anything active. Motion is short and soft
(150-250 ms, ease-out) so the interface feels calm.
"""

from __future__ import annotations

from dataclasses import dataclass

from PySide6.QtGui import QColor, QFont, QFontDatabase, QPalette
from PySide6.QtWidgets import QApplication


@dataclass(frozen=True)
class Palette:
    # Surfaces, darkest to lightest (tone, not borders, separates areas)
    bg: str = "#0B0B0C"
    surface: str = "#141416"  # panels / cards
    surface2: str = "#1E1E21"  # controls: inputs, pills, round buttons
    surface3: str = "#2A2A2E"  # hover / pressed / slider fill
    stage: str = "#000000"  # video area
    # Accent (lime playhead from the editor reference)
    accent: str = "#E4F17A"
    accent_dim: str = "rgba(228, 241, 122, 0.16)"
    # Text
    text: str = "#F4F4F5"
    text_dim: str = "#A1A1AA"
    text_faint: str = "#5F5F67"
    text_on_light: str = "#0B0B0C"
    # Status
    ok: str = "#E4F17A"
    warn: str = "#F5C451"
    danger: str = "#FF5A5F"

    # Compatibility names used by older widgets.
    @property
    def glass(self) -> str:
        return self.surface2

    @property
    def glass_hover(self) -> str:
        return self.surface3

    @property
    def glass_pressed(self) -> str:
        return "#34343A"

    @property
    def glass_border(self) -> str:
        return "rgba(255, 255, 255, 0.0)"

    @property
    def ember_deep(self) -> str:
        return self.bg

    @property
    def ember_lo(self) -> str:
        return self.surface

    @property
    def ember(self) -> str:
        return self.surface

    @property
    def ember_hi(self) -> str:
        return self.surface2

    @property
    def accent_soft(self) -> str:
        return self.accent


P = Palette()

# Face overlay colours by role (QColor-compatible). Everything is "a face" now.
ROLE_COLORS = {"whitelist": P.accent, "target": P.accent, "known": P.accent, "unknown": P.accent, "pending": P.accent}

RADIUS_CARD = 20
RADIUS_PILL = 999
CONTROL_H = 40  # standard control height
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
    background: {P.surface3};
    color: {P.text};
    border: none;
    border-radius: 8px;
    padding: 6px 10px;
}}
QLabel[role="display"] {{ font-size: 30pt; font-weight: 300; }}
QLabel[role="title"] {{ font-size: 20pt; font-weight: 300; }}
QLabel[role="h2"] {{ font-size: 12pt; font-weight: 500; }}
QLabel[role="dim"] {{ color: {P.text_dim}; }}
QLabel[role="faint"] {{ color: {P.text_faint}; font-size: 8.5pt; }}
QLabel[role="caption"] {{ color: {P.text_faint}; font-size: 7.5pt; font-weight: 600; letter-spacing: 1.2px; }}
QLabel[role="value"] {{ font-size: 16pt; font-weight: 300; }}

/* ---- Inputs: flat, no outline; focus = lighter tone ---------------- */
QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox {{
    background: {P.surface2};
    border: none;
    border-radius: 20px;
    padding: 0 18px;
    min-height: {CONTROL_H}px;
    max-height: {CONTROL_H}px;
    selection-background-color: {P.accent};
    selection-color: {P.text_on_light};
}}
QLineEdit:hover, QComboBox:hover {{ background: #242428; }}
QLineEdit:focus, QComboBox:focus {{ background: {P.surface3}; }}
QLineEdit:disabled, QComboBox:disabled {{ color: {P.text_faint}; }}
QComboBox::drop-down {{ border: none; width: 28px; }}
QComboBox::down-arrow {{ image: none; width: 0; }}
QComboBox QAbstractItemView {{
    background: {P.surface2};
    border: none;
    border-radius: 12px;
    padding: 6px;
    selection-background-color: {P.surface3};
}}

/* ---- Buttons ----------------------------------------------------- */
QPushButton {{
    background: {P.surface2};
    border: none;
    border-radius: 20px;
    padding: 0 20px;
    min-height: {CONTROL_H}px;
    max-height: {CONTROL_H}px;
    font-weight: 500;
}}
QPushButton:hover {{ background: {P.surface3}; }}
QPushButton:pressed {{ background: #34343A; }}
QPushButton:disabled {{ color: {P.text_faint}; background: #17171A; }}
QPushButton[variant="primary"] {{
    background: {P.text};
    color: {P.text_on_light};
    font-weight: 600;
}}
QPushButton[variant="primary"]:hover {{ background: #FFFFFF; }}
QPushButton[variant="primary"]:pressed {{ background: {P.accent}; }}
QPushButton[variant="primary"]:disabled {{ background: #3A3A3F; color: {P.text_faint}; }}
QPushButton[variant="danger"] {{ background: rgba(255, 90, 95, 0.16); color: {P.danger}; }}
QPushButton[variant="pill"] {{
    min-height: 30px;
    max-height: 30px;
    border-radius: 15px;
    padding: 0 14px;
    font-size: 9pt;
    font-weight: 500;
    color: {P.text_dim};
}}
QPushButton[variant="pill"][scale="large"] {{
    min-height: {CONTROL_H}px;
    max-height: {CONTROL_H}px;
    border-radius: 20px;
    padding: 0 18px;
    font-size: 9.5pt;
}}
QPushButton[variant="pill"]:hover {{ color: {P.text}; }}
QPushButton[variant="pill"]:checked {{
    background: {P.text};
    color: {P.text_on_light};
}}

/* ---- Scroll bars -------------------------------------------------- */
QScrollBar:vertical {{ background: transparent; width: 6px; margin: 4px 0; }}
QScrollBar::handle:vertical {{ background: {P.surface3}; border-radius: 3px; min-height: 32px; }}
QScrollBar::handle:vertical:hover {{ background: #45454B; }}
QScrollBar:horizontal {{ background: transparent; height: 6px; margin: 0 4px; }}
QScrollBar::handle:horizontal {{ background: {P.surface3}; border-radius: 3px; min-width: 32px; }}
QScrollBar::add-line, QScrollBar::sub-line, QScrollBar::add-page, QScrollBar::sub-page {{ background: none; border: none; width: 0; height: 0; }}

/* ---- Lists / progress -------------------------------------------- */
QListWidget {{ background: transparent; border: none; }}
QListWidget::item {{
    background: {P.surface2};
    border: none;
    border-radius: 14px;
    padding: 10px 14px;
    margin: 3px 0;
}}
QListWidget::item:hover {{ background: #242428; }}
QListWidget::item:selected {{ background: {P.surface3}; color: {P.text}; }}
QProgressBar {{
    background: {P.surface2};
    border: none;
    border-radius: 4px;
    min-height: 8px;
    max-height: 8px;
    text-align: center;
    font-size: 1pt;
    color: transparent;
}}
QProgressBar::chunk {{ border-radius: 4px; background: {P.accent}; }}
QMessageBox, QInputDialog, QFileDialog, QDialog {{ background: {P.surface}; }}
QMessageBox QLabel, QInputDialog QLabel {{ color: {P.text}; }}
QMenu {{
    background: {P.surface2};
    border: none;
    border-radius: 12px;
    padding: 6px;
}}
QMenu::item {{ padding: 8px 18px; border-radius: 8px; }}
QMenu::item:selected {{ background: {P.surface3}; }}
"""


def apply_theme(app: QApplication) -> None:
    app.setStyle("Fusion")  # consistent rendering of QSS on every Windows version
    app.setFont(app_font(10))
    pal = QPalette()
    bg = qcolor(P.bg)
    pal.setColor(QPalette.ColorRole.Window, bg)
    pal.setColor(QPalette.ColorRole.Base, qcolor(P.surface2))
    pal.setColor(QPalette.ColorRole.AlternateBase, qcolor(P.surface))
    pal.setColor(QPalette.ColorRole.Text, qcolor(P.text))
    pal.setColor(QPalette.ColorRole.WindowText, qcolor(P.text))
    pal.setColor(QPalette.ColorRole.ButtonText, qcolor(P.text))
    pal.setColor(QPalette.ColorRole.Button, qcolor(P.surface2))
    pal.setColor(QPalette.ColorRole.Highlight, qcolor(P.accent))
    pal.setColor(QPalette.ColorRole.HighlightedText, qcolor(P.text_on_light))
    pal.setColor(QPalette.ColorRole.PlaceholderText, qcolor(P.text_faint))
    pal.setColor(QPalette.ColorRole.ToolTipBase, qcolor(P.surface3))
    pal.setColor(QPalette.ColorRole.ToolTipText, qcolor(P.text))
    app.setPalette(pal)
    app.setStyleSheet(STYLESHEET)
