"""Writes the Windows version resource (file properties: publisher, version, description) for PyInstaller."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read_version() -> str:
    text = (ROOT / "lumo_materials" / "__init__.py").read_text(encoding="utf-8")
    m = re.search(r'__version__\s*=\s*"([^"]+)"', text)
    if not m:
        sys.exit("version not found in lumo_materials/__init__.py")
    return m.group(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--publisher-json", default="")
    ap.add_argument("--publisher", default="")
    ap.add_argument("--out", default=str(ROOT / "build" / "version_info.txt"))
    a = ap.parse_args()
    publisher = a.publisher
    if not publisher and a.publisher_json and Path(a.publisher_json).exists():
        publisher = json.loads(Path(a.publisher_json).read_text(encoding="utf-8-sig")).get("publisher", "")
    publisher = publisher or "lumo"
    ver = read_version()
    parts = [int(x) for x in re.findall(r"\d+", ver)[:4]]
    parts += [0] * (4 - len(parts))
    tup = tuple(parts)

    def s(v: str) -> str:
        return v.replace("\\", "\\\\").replace("'", "\\'")

    text = f"""# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(filevers={tup}, prodvers={tup}, mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1,
                    subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', '{s(publisher)}'),
      StringStruct('FileDescription', 'lumo materials - offline PBR material library'),
      StringStruct('FileVersion', '{ver}'),
      StringStruct('InternalName', 'lumo-materials'),
      StringStruct('LegalCopyright', 'Copyright (C) {s(publisher)}'),
      StringStruct('OriginalFilename', 'lumo-materials.exe'),
      StringStruct('ProductName', 'lumo materials'),
      StringStruct('ProductVersion', '{ver}')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
"""
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"version {ver}, publisher {publisher} -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
