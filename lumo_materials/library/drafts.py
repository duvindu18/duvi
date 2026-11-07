"""Unsaved work: kept in the program data folder until it is saved or discarded."""
from __future__ import annotations

import shutil
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .paths import is_inside
from .settings import read_json, write_json_atomic
from .store import now_iso


@dataclass
class Draft:
    id: str
    kind: str                                   # photo | import | adjust | regenerate
    name: str = ""
    category: str = ""
    tags: list[str] = field(default_factory=list)
    description: str = ""
    generation: dict[str, Any] | None = None
    adjustments: dict[str, Any] | None = None
    material_id: str | None = None              # adjust / regenerate: the saved material it belongs to
    assignments: list[dict[str, str]] = field(default_factory=list)   # import: [{file, role, convention}]
    created: str = ""
    modified: str = ""
    folder: Path | None = None

    @property
    def source(self) -> Path | None:
        if not self.folder:
            return None
        for p in sorted(self.folder.glob("source.*")):
            return p
        return None

    def files(self) -> list[Path]:
        return sorted((self.folder / "files").iterdir()) if self.folder and (self.folder / "files").is_dir() else []

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("folder", None)
        return d


class DraftStore:
    def __init__(self, folder: Path):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)

    def _dir(self, did: str) -> Path:
        d = self.folder / did
        if not is_inside(d, self.folder) or d == self.folder:
            raise ValueError("bad draft id")
        return d

    def new(self, kind: str, source: str | Path | None = None, files: list[str | Path] = (), **meta: Any) -> Draft:
        did = uuid.uuid4().hex
        d = self._dir(did)
        d.mkdir(parents=True)
        if source:
            sp = Path(source)
            shutil.copy2(sp, d / ("source" + sp.suffix.lower()))
        assignments = list(meta.pop("assignments", []) or [])
        if files:
            (d / "files").mkdir()
            names = set()
            for f in files:
                fp = Path(f)
                name = fp.name
                i = 2
                while name.lower() in names:
                    name = f"{fp.stem} ({i}){fp.suffix}"
                    i += 1
                names.add(name.lower())
                shutil.copy2(fp, d / "files" / name)
                for a in assignments:   # point assignments at the copies
                    if Path(a.get("file", "")) == fp:
                        a["file"] = name
        ts = now_iso()
        dr = Draft(id=did, kind=kind, created=ts, modified=ts, folder=d, assignments=assignments, **meta)
        self.save(dr)
        return dr

    def save(self, dr: Draft) -> None:
        dr.modified = now_iso()
        write_json_atomic(self._dir(dr.id) / "draft.json", dr.to_json())

    def get(self, did: str) -> Draft | None:
        d = self._dir(did)
        data = read_json(d / "draft.json", None)
        if not isinstance(data, dict):
            return None
        known = {k: data[k] for k in Draft.__dataclass_fields__ if k in data and k != "folder"}
        known.setdefault("id", did)
        known.setdefault("kind", "photo")
        return Draft(**known, folder=d)

    def list(self) -> list[Draft]:
        out = [self.get(p.name) for p in self.folder.iterdir() if p.is_dir()]
        return sorted([d for d in out if d], key=lambda d: d.modified, reverse=True)

    def file_path(self, dr: Draft, name: str) -> Path:
        p = self._dir(dr.id) / "files" / Path(name).name
        return p

    def discard(self, did: str) -> None:
        shutil.rmtree(self._dir(did), ignore_errors=True)
