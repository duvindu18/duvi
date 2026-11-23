"""Visual system: flat near-black surfaces, hairline borders, pill controls.

Tokens mirror the reference design: white pill primary buttons, outlined pill
secondaries, rounded cards with a 1px border, a white "active" pill in the
sidebar, small count badges, white toggles and a single yellow accent.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Palette:
    name: str
    bg: str            # window
    sidebar: str
    surface: str       # cards
    surface2: str      # inputs, hover
    border: str
    border_strong: str
    text: str
    text_muted: str
    text_faint: str
    primary_bg: str    # white pill
    primary_fg: str
    accent: str        # yellow
    danger: str
    success: str
    viewport_top: str
    viewport_bottom: str


DARK = Palette(
    name="dark", bg="#0a0a0b", sidebar="#0a0a0b", surface="#111113", surface2="#18181b",
    border="#1f1f22", border_strong="#2c2c31", text="#f2f2f3", text_muted="#9a9aa1",
    text_faint="#64646b", primary_bg="#f5f5f6", primary_fg="#0a0a0b", accent="#f5c518",
    danger="#ef4444", success="#22c55e", viewport_top="#17171a", viewport_bottom="#0c0c0e",
)

LIGHT = Palette(
    name="light", bg="#f6f6f7", sidebar="#f6f6f7", surface="#ffffff", surface2="#f0f0f2",
    border="#e4e4e7", border_strong="#d4d4d8", text="#0a0a0b", text_muted="#5f5f66",
    text_faint="#9a9aa1", primary_bg="#0a0a0b", primary_fg="#ffffff", accent="#d9a400",
    danger="#dc2626", success="#16a34a", viewport_top="#e9e9ec", viewport_bottom="#d6d6da",
)

FONT_STACK = "'Inter', 'Segoe UI Variable Text', 'Segoe UI', sans-serif"


def qss(p: Palette) -> str:
    return f"""
* {{ font-family: {FONT_STACK}; font-size: 13px; color: {p.text}; outline: 0; }}
QMainWindow, QWidget#Root {{ background: {p.bg}; }}
QWidget {{ background: transparent; }}
QToolTip {{ background: {p.surface2}; color: {p.text}; border: 1px solid {p.border_strong};
            border-radius: 8px; padding: 6px 8px; }}

/* ---- sidebar ---------------------------------------------------------- */
QWidget#Sidebar {{ background: {p.sidebar}; border-right: 1px solid {p.border}; }}
QLabel#Brand {{ font-size: 15px; font-weight: 700; }}
QLabel#BrandDot {{ color: {p.accent}; font-size: 18px; font-weight: 800; }}
QLabel#Crumb {{ color: {p.text_faint}; }}
QLabel#Section {{ font-weight: 600; padding: 14px 10px 4px 10px; }}
QPushButton#NavItem {{ text-align: left; border: 0; border-radius: 16px; padding: 7px 12px;
                      color: {p.text}; background: transparent; font-weight: 500; }}
QPushButton#NavItem:hover {{ background: {p.surface2}; }}
QPushButton#NavItem:checked {{ background: {p.primary_bg}; color: {p.primary_fg}; }}
QLabel#Badge {{ background: {p.surface2}; color: {p.text_muted}; border-radius: 6px;
               padding: 1px 6px; font-size: 11px; font-weight: 600; }}
QLabel#BadgeAlert {{ background: {p.danger}; color: white; border-radius: 6px;
                    padding: 1px 6px; font-size: 11px; font-weight: 700; }}
QLabel#StatusDot {{ color: {p.success}; font-size: 11px; }}
QLabel#StatusText {{ color: {p.text_muted}; font-size: 12px; }}

/* ---- headings / text ---------------------------------------------------- */
QLabel#H1 {{ font-size: 26px; font-weight: 700; letter-spacing: -0.5px; }}
QLabel#H2 {{ font-size: 19px; font-weight: 700; letter-spacing: -0.3px; }}
QLabel#H3 {{ font-size: 14px; font-weight: 600; }}
QLabel#Muted {{ color: {p.text_muted}; }}
QLabel#Faint {{ color: {p.text_faint}; font-size: 12px; }}
QLabel#Mono {{ font-family: 'Cascadia Mono', 'Consolas', monospace; font-size: 12px; }}
QLabel#Kicker {{ color: {p.text_faint}; font-size: 10px; font-weight: 700; letter-spacing: 1px; }}
QLabel#Accent {{ color: {p.accent}; font-weight: 600; }}

/* ---- cards ------------------------------------------------------------- */
QFrame#Card {{ background: {p.surface}; border: 1px solid {p.border}; border-radius: 14px; }}
QFrame#CardFlat {{ background: transparent; border: 1px solid {p.border}; border-radius: 14px; }}
QFrame#Divider {{ background: {p.border}; max-height: 1px; min-height: 1px; border: 0; }}
QFrame#DropZone {{ background: {p.surface}; border: 1px dashed {p.border_strong}; border-radius: 16px; }}
QFrame#DropZone[hover="true"] {{ border: 1px dashed {p.accent}; }}
QFrame#IconTile {{ background: {p.surface2}; border: 1px solid {p.border}; border-radius: 10px; }}
QFrame#Viewport {{ background: {p.surface}; border: 1px solid {p.border}; border-radius: 14px; }}

/* ---- buttons ----------------------------------------------------------- */
QPushButton {{ background: transparent; border: 1px solid {p.border_strong}; border-radius: 15px;
              padding: 6px 16px; min-height: 18px; font-weight: 600; }}
QPushButton:hover {{ background: {p.surface2}; }}
QPushButton:pressed {{ background: {p.border}; }}
QPushButton:disabled {{ color: {p.text_faint}; border-color: {p.border}; }}
QPushButton#Primary {{ background: {p.primary_bg}; color: {p.primary_fg}; border: 0; }}
QPushButton#Primary:hover {{ background: {p.text_muted}; }}
QPushButton#Primary:disabled {{ background: {p.border_strong}; color: {p.text_faint}; }}
QPushButton#Ghost {{ border: 0; padding: 6px 10px; color: {p.text_muted}; }}
QPushButton#Ghost:hover {{ color: {p.text}; background: {p.surface2}; }}
QPushButton#Icon {{ border: 0; border-radius: 15px; padding: 5px; min-width: 20px; }}
QPushButton#Icon:hover {{ background: {p.surface2}; }}
QPushButton#Seg {{ border: 0; border-radius: 12px; padding: 4px 12px; min-height: 16px; color: {p.text_muted}; }}
QPushButton#Seg:checked {{ background: {p.primary_bg}; color: {p.primary_fg}; }}
QFrame#SegGroup {{ background: {p.surface2}; border: 1px solid {p.border}; border-radius: 16px; }}
QPushButton#Link {{ border: 0; padding: 0; color: {p.accent}; font-weight: 600; }}

/* ---- inputs ------------------------------------------------------------ */
QLineEdit {{ background: {p.surface2}; border: 1px solid {p.border}; border-radius: 15px;
            padding: 6px 14px; min-height: 18px; selection-background-color: {p.accent}; selection-color: black; }}
QLineEdit:focus {{ border-color: {p.border_strong}; }}
QLineEdit#Search {{ padding-left: 34px; }}
QComboBox {{ background: transparent; border: 1px solid {p.border_strong}; border-radius: 10px;
            padding: 8px 14px; }}
QComboBox:hover {{ background: {p.surface2}; }}
QComboBox::drop-down {{ border: 0; width: 26px; }}
QComboBox QAbstractItemView {{ background: {p.surface}; border: 1px solid {p.border_strong};
                              selection-background-color: {p.surface2}; selection-color: {p.text};
                              padding: 4px; outline: 0; }}
QSpinBox, QDoubleSpinBox {{ background: {p.surface2}; border: 1px solid {p.border}; border-radius: 8px;
                           padding: 4px 8px; }}
QCheckBox {{ spacing: 8px; }}
QCheckBox::indicator {{ width: 16px; height: 16px; border-radius: 5px; border: 1px solid {p.border_strong};
                       background: {p.surface2}; }}
QCheckBox::indicator:checked {{ background: {p.primary_bg}; border-color: {p.primary_bg}; }}

/* ---- trees / lists ----------------------------------------------------- */
QTreeWidget, QListWidget, QTableWidget {{ background: transparent; border: 0; }}
QTreeView::item, QListView::item {{ padding: 5px 4px; border-radius: 8px; }}
QTreeView::item:hover, QListView::item:hover {{ background: {p.surface2}; }}
QTreeView::item:selected, QListView::item:selected {{ background: {p.surface2}; color: {p.text}; }}
QTreeView::indicator {{ width: 14px; height: 14px; border-radius: 4px; border: 1px solid {p.border_strong};
                       background: {p.surface2}; }}
QTreeView::indicator:checked {{ background: {p.primary_bg}; border-color: {p.primary_bg}; }}
QTreeView::indicator:indeterminate {{ background: {p.text_faint}; border-color: {p.text_faint}; }}
QHeaderView::section {{ background: transparent; color: {p.text_faint}; border: 0;
                       padding: 4px 6px; font-size: 11px; font-weight: 600; }}
QTreeView::branch {{ background: transparent; }}
QTreeView::branch:selected, QTreeView::branch:hover {{ background: transparent; }}
QTreeView {{ selection-background-color: {p.surface2}; show-decoration-selected: 0; }}

/* ---- scrollbars ------------------------------------------------------- */
QScrollArea {{ border: 0; background: transparent; }}
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 2px; }}
QScrollBar::handle:vertical {{ background: {p.border_strong}; border-radius: 3px; min-height: 30px; }}
QScrollBar::handle:vertical:hover {{ background: {p.text_faint}; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; margin: 2px; }}
QScrollBar::handle:horizontal {{ background: {p.border_strong}; border-radius: 3px; min-width: 30px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; height: 0; }}
QScrollBar::add-page, QScrollBar::sub-page {{ background: transparent; }}

QProgressBar {{ background: {p.surface2}; border: 0; border-radius: 3px; max-height: 6px; min-height: 6px; }}
QProgressBar::chunk {{ background: {p.primary_bg}; border-radius: 3px; }}
QPlainTextEdit {{ background: {p.surface}; border: 1px solid {p.border}; border-radius: 12px; padding: 8px;
                 font-family: 'Cascadia Mono', 'Consolas', monospace; font-size: 12px; color: {p.text_muted}; }}
QSplitter::handle {{ background: transparent; }}

/* ---- toast ------------------------------------------------------------ */
QFrame#Toast {{ background: {p.primary_bg}; border-radius: 17px; }}
QFrame#Toast QLabel {{ color: {p.primary_fg}; font-weight: 500; }}
QFrame#Toast QPushButton {{ border: 0; color: {p.accent}; font-weight: 700; padding: 0 4px; background: transparent; }}
/* ---- app shell: rail, header, status bar ----------------------------- */
QWidget#Rail {{ background: {p.sidebar}; border-right: 1px solid {p.border}; }}
QToolButton#RailBtn {{ border: 0; border-radius: 10px; padding: 8px; background: transparent; }}
QToolButton#RailBtn:hover {{ background: {p.surface2}; }}
QToolButton#RailBtn:checked {{ background: {p.primary_bg}; }}
QLabel#RailMark {{ background: {p.primary_bg}; color: {p.primary_fg}; border-radius: 9px;
                  font-weight: 800; font-size: 13px; }}
QWidget#Header {{ background: {p.bg}; border-bottom: 1px solid {p.border}; }}
QLabel#Crumb1 {{ font-weight: 600; }}
QLabel#Crumb2 {{ color: {p.text_faint}; }}
QWidget#StatusBar {{ background: {p.bg}; border-top: 1px solid {p.border}; }}
QWidget#StatusBar QLabel {{ color: {p.text_muted}; font-size: 12px; }}
QLabel#Dot {{ font-size: 10px; }}

/* ---- panes ------------------------------------------------------------ */
QFrame#Pane {{ background: {p.surface}; border: 1px solid {p.border}; border-radius: 12px; }}
QLabel#PaneTitle {{ font-weight: 600; font-size: 13px; }}
QLabel#FormLabel {{ color: {p.text_muted}; }}
QLabel#Section2 {{ color: {p.text_faint}; font-size: 11px; font-weight: 700; letter-spacing: 0.6px;
                  padding-top: 6px; }}
QLineEdit#Filter {{ background: {p.bg}; border-radius: 10px; padding: 5px 10px 5px 30px; }}
QToolButton#Tool {{ border: 0; border-radius: 8px; padding: 5px; background: transparent; }}
QToolButton#Tool:hover {{ background: {p.surface2}; }}
QToolButton#Tool:checked {{ background: {p.surface2}; border: 1px solid {p.border_strong}; }}
QToolButton#Disclosure {{ border: 0; padding: 4px 0; color: {p.text_muted}; font-weight: 600;
                         background: transparent; text-align: left; }}
QToolButton#Disclosure:hover {{ color: {p.text}; }}
QTabBar {{ background: transparent; }}
QTabBar::tab {{ background: transparent; color: {p.text_muted}; padding: 8px 2px; margin-right: 16px;
               border: 0; border-bottom: 2px solid transparent; font-weight: 600; }}
QTabBar::tab:selected {{ color: {p.text}; border-bottom: 2px solid {p.text}; }}
QTabBar::tab:hover {{ color: {p.text}; }}
QPushButton#PrimaryWide {{ background: {p.primary_bg}; color: {p.primary_fg}; border: 0;
                          border-radius: 10px; padding: 10px 16px; font-weight: 700; }}
QPushButton#PrimaryWide:hover {{ background: {p.text_muted}; }}
QPushButton#PrimaryWide:disabled {{ background: {p.border_strong}; color: {p.text_faint}; }}
QPushButton#Tile {{ border: 1px solid {p.border}; border-radius: 8px; padding: 0; margin: 0;
                   min-height: 54px; max-height: 54px; min-width: 54px; max-width: 54px; background: {p.bg}; }}
QPushButton#Tile:hover {{ border-color: {p.text_muted}; }}
QPushButton#RecentRow {{ text-align: left; border: 0; border-radius: 10px; padding: 10px 12px; }}
QPushButton#RecentRow:hover {{ background: {p.surface2}; }}
QMenu {{ background: {p.surface}; border: 1px solid {p.border_strong}; border-radius: 10px; padding: 6px; }}
QMenu::item {{ padding: 6px 14px; border-radius: 6px; }}
QMenu::item:selected {{ background: {p.surface2}; }}
"""
