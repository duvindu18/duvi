# -*- coding: utf-8 -*-
"""D5 Bridge panel for 3ds Max 2021+ (PySide2 or PySide6, both ship with Max).

* Lists the variants in the open file (top-level groups, layers or root
  objects - MaxTree files usually keep each tree version in its own group).
* Shows how every Corona / V-Ray material converts (channels found, baked maps).
* Select / isolate a variant in the viewport (which is the textured preview).
* "Open in D5 Bridge" sends the checked variants to the desktop app for
  preview, optimisation and export. "Quick export" exports straight to FBX
  using the app's command line with the last used settings.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

import pymxs  # type: ignore

rt = pymxs.runtime
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import d5bridge_max_export as exp  # noqa: E402

try:
    from PySide6 import QtCore, QtWidgets  # type: ignore
except ImportError:  # 3ds Max 2021-2024
    from PySide2 import QtCore, QtWidgets  # type: ignore

STYLE = """
QWidget { background:#0b0b0c; color:#ececec; font-family:'Segoe UI'; font-size:12px; }
QTreeWidget, QTableWidget { background:#121214; border:1px solid #232326; border-radius:10px; }
QHeaderView::section { background:#121214; color:#8b8b90; border:0; padding:4px; }
QPushButton { background:transparent; border:1px solid #2c2c30; border-radius:14px; padding:5px 14px; }
QPushButton:hover { background:#1b1b1e; }
QPushButton#primary { background:#f4f4f5; color:#0b0b0c; border:0; font-weight:600; }
QLineEdit, QComboBox { background:#121214; border:1px solid #2c2c30; border-radius:14px; padding:4px 10px; }
QCheckBox::indicator { width:14px; height:14px; }
QLabel#muted { color:#8b8b90; }
QLabel#h1 { font-size:16px; font-weight:600; }
"""


def find_app() -> str:
    s = QtCore.QSettings("D5Bridge", "MaxPanel")
    p = s.value("app_path", "")
    if p and os.path.isfile(p):
        return p
    for c in (os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "D5 Bridge", "D5Bridge.exe"),
              os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "D5 Bridge", "D5Bridge.exe")):
        if os.path.isfile(c):
            return c
    return ""


def collect_variants() -> list:
    """[(name, kind, [nodes])] - groups first, then layers, then root objects."""
    groups = []
    for n in rt.objects:
        try:
            if rt.isGroupHead(n) and n.parent is None:
                groups.append((str(n.name), "group", [n]))
        except Exception:  # noqa: BLE001
            pass
    if len(groups) >= 2:
        return groups
    layers = []
    for i in range(rt.LayerManager.count):
        lay = rt.LayerManager.getLayer(i)
        nodes = [o for o in rt.objects if str(o.layer.name) == str(lay.name) and
                 rt.superClassOf(o) == rt.GeometryClass]
        if nodes and str(lay.name) != "0":
            layers.append((str(lay.name), "layer", nodes))
    if len(layers) >= 2:
        return layers
    roots = [(str(o.name), "object", [o]) for o in rt.rootNode.children
             if rt.superClassOf(o) == rt.GeometryClass or rt.isGroupHead(o)]
    return groups or layers or roots


class Panel(QtWidgets.QWidget):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("D5 Bridge")
        self.setWindowFlags(QtCore.Qt.Window)
        self.setStyleSheet(STYLE)
        self.resize(560, 680)
        self.settings = QtCore.QSettings("D5Bridge", "MaxPanel")

        lay = QtWidgets.QVBoxLayout(self)
        lay.setContentsMargins(16, 16, 16, 16)
        lay.setSpacing(10)
        h = QtWidgets.QLabel("D5 Bridge")
        h.setObjectName("h1")
        sub = QtWidgets.QLabel("Pick the tree variants to send to D5 Render. Hidden variants are included.")
        sub.setObjectName("muted")
        sub.setWordWrap(True)
        lay.addWidget(h)
        lay.addWidget(sub)

        self.tree = QtWidgets.QTreeWidget()
        self.tree.setHeaderLabels(["Variant", "Type", "Objects", "Faces"])
        self.tree.setRootIsDecorated(False)
        self.tree.itemSelectionChanged.connect(self.on_select)
        lay.addWidget(self.tree, 2)

        row = QtWidgets.QHBoxLayout()
        for text, fn in (("Refresh", self.refresh), ("Select", self.select_variant),
                         ("Isolate", self.isolate), ("All", lambda: self.check_all(True)),
                         ("None", lambda: self.check_all(False))):
            b = QtWidgets.QPushButton(text)
            b.clicked.connect(fn)
            row.addWidget(b)
        row.addStretch(1)
        lay.addLayout(row)

        self.mats = QtWidgets.QTableWidget(0, 3)
        self.mats.setHorizontalHeaderLabels(["Material", "Type", "Channels for D5"])
        self.mats.horizontalHeader().setStretchLastSection(True)
        self.mats.verticalHeader().setVisible(False)
        lay.addWidget(self.mats, 2)

        opts = QtWidgets.QHBoxLayout()
        self.bake = QtWidgets.QCheckBox("Bake procedural maps")
        self.bake.setChecked(True)
        self.proxies = QtWidgets.QCheckBox("Convert proxies")
        self.proxies.setChecked(True)
        opts.addWidget(self.bake)
        opts.addWidget(self.proxies)
        opts.addStretch(1)
        lay.addLayout(opts)

        out_row = QtWidgets.QHBoxLayout()
        self.out = QtWidgets.QLineEdit(self.settings.value("out_dir", os.path.expanduser("~/Documents/D5 Bridge")))
        browse = QtWidgets.QPushButton("Folder")
        browse.clicked.connect(self.pick_out)
        out_row.addWidget(self.out, 1)
        out_row.addWidget(browse)
        lay.addLayout(out_row)

        act = QtWidgets.QHBoxLayout()
        self.status = QtWidgets.QLabel("")
        self.status.setObjectName("muted")
        quick = QtWidgets.QPushButton("Quick export")
        quick.clicked.connect(lambda: self.send(open_app=False))
        go = QtWidgets.QPushButton("Open in D5 Bridge")
        go.setObjectName("primary")
        go.clicked.connect(lambda: self.send(open_app=True))
        act.addWidget(self.status, 1)
        act.addWidget(quick)
        act.addWidget(go)
        lay.addLayout(act)
        self.variants: list = []
        self.refresh()

    # ------------------------------------------------------------------ #
    def refresh(self) -> None:
        self.tree.clear()
        self.variants = collect_variants()
        for name, kind, nodes in self.variants:
            allnodes = self._expand(nodes)
            faces = 0
            for n in allnodes:
                try:
                    faces += int(rt.getPolygonCount(n)[0])
                except Exception:  # noqa: BLE001
                    pass
            it = QtWidgets.QTreeWidgetItem([name, kind, str(len(allnodes)), f"{faces:,}"])
            it.setCheckState(0, QtCore.Qt.Checked)
            self.tree.addTopLevelItem(it)
        for i in range(4):
            self.tree.resizeColumnToContents(i)
        self.status.setText(f"{len(self.variants)} variants")
        self.show_materials(self._expand([n for _, _, ns in self.variants for n in ns]))

    def _expand(self, nodes) -> list:
        out = []
        stack = list(nodes)
        while stack:
            n = stack.pop()
            if rt.superClassOf(n) == rt.GeometryClass:
                out.append(n)
            stack.extend(list(n.children))
        return out

    def show_materials(self, nodes) -> None:
        baker = exp.Baker(tempfile.gettempdir(), False, [])
        seen = {}
        for n in nodes:
            m = n.material
            if m is None:
                continue
            subs = list(m.materialList) if exp.cls(m) in ("Multimaterial", "VRayMultiSubMtl") else [m]
            for s in subs:
                if s is not None and str(s.name) not in seen:
                    try:
                        seen[str(s.name)] = exp.convert_material(s, baker)
                    except Exception as e:  # noqa: BLE001
                        seen[str(s.name)] = {"source_type": exp.cls(s), "maps": {}, "notes": [str(e)]}
        self.mats.setRowCount(len(seen))
        for r, (name, md) in enumerate(seen.items()):
            chans = ", ".join(sorted(md.get("maps", {}).keys())) or "constant colour"
            if md.get("notes"):
                chans += "  (!)"
            self.mats.setItem(r, 0, QtWidgets.QTableWidgetItem(name))
            self.mats.setItem(r, 1, QtWidgets.QTableWidgetItem(md.get("source_type", "")))
            item = QtWidgets.QTableWidgetItem(chans)
            item.setToolTip("\n".join(md.get("notes", [])))
            self.mats.setItem(r, 2, item)
        self.mats.resizeColumnsToContents()

    def selected_variant(self):
        it = self.tree.currentItem()
        if it is None:
            return None
        return self.variants[self.tree.indexOfTopLevelItem(it)]

    def on_select(self) -> None:
        v = self.selected_variant()
        if v:
            self.show_materials(self._expand(v[2]))

    def select_variant(self) -> None:
        v = self.selected_variant()
        if v:
            rt.select(self._expand(v[2]) + [n for n in v[2]])
            rt.execute("max zoomext sel")
            rt.redrawViews()

    def isolate(self) -> None:
        self.select_variant()
        try:
            rt.IsolateSelection.EnterIsolateSelectionMode()
        except Exception:  # noqa: BLE001
            pass

    def check_all(self, state: bool) -> None:
        for i in range(self.tree.topLevelItemCount()):
            self.tree.topLevelItem(i).setCheckState(0, QtCore.Qt.Checked if state else QtCore.Qt.Unchecked)

    def pick_out(self) -> None:
        d = QtWidgets.QFileDialog.getExistingDirectory(self, "Output folder", self.out.text())
        if d:
            self.out.setText(d)

    # ------------------------------------------------------------------ #
    def send(self, open_app: bool) -> None:
        chosen = []
        for i in range(self.tree.topLevelItemCount()):
            if self.tree.topLevelItem(i).checkState(0) == QtCore.Qt.Checked:
                chosen.append(self.variants[i])
        if not chosen:
            self.status.setText("Tick at least one variant")
            return
        self.settings.setValue("out_dir", self.out.text())
        base = os.path.splitext(str(rt.maxFileName) or "scene")[0]
        bundle = os.path.join(tempfile.gettempdir(), "D5Bridge", exp.safe_name(base) + "_bundle")
        nodes = [n for _, _, ns in chosen for n in ns]
        self.status.setText("Exporting from 3ds Max...")
        QtWidgets.QApplication.processEvents()
        rt.select(nodes)
        opts = {"bake_procedural": self.bake.isChecked(), "convert_proxies": self.proxies.isChecked()}
        try:
            manifest = exp.export_bundle(bundle, opts, selected_only=True)
        except Exception as e:  # noqa: BLE001
            self.status.setText(f"Failed: {e}")
            return
        # record which variants the user picked so the app pre-selects them
        with open(manifest, "r", encoding="utf-8") as f:
            data = json.load(f)
        data["picked_variants"] = [{"name": n, "kind": k, "nodes": [str(x.name) for x in self._expand(ns)]}
                                   for n, k, ns in chosen]
        with open(manifest, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1)

        app = find_app()
        if not app:
            p, _ = QtWidgets.QFileDialog.getOpenFileName(self, "Locate D5Bridge.exe", "", "D5Bridge.exe (*.exe)")
            if not p:
                self.status.setText(f"Bundle ready: {bundle}")
                return
            app = p
            self.settings.setValue("app_path", app)
        args = [app, bundle] if open_app else [app, "--export", bundle, "--out", self.out.text(),
                                               "--split-variants"]
        subprocess.Popen(args, close_fds=True)
        self.status.setText("Opened in D5 Bridge" if open_app else f"Exporting to {self.out.text()}")


_panel = None


def show() -> None:
    global _panel
    try:
        import qtmax  # type: ignore  # 3ds Max 2022+
        parent = qtmax.GetQMaxMainWindow()
    except Exception:  # noqa: BLE001
        parent = None
    if _panel is not None:
        _panel.close()
    _panel = Panel(parent)
    _panel.show()


show()
