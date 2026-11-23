"""Low-level FBX node tree: binary reader/writer and a minimal ASCII reader.

Binary layout follows the public reverse-engineered spec (as used by Blender's
io_scene_fbx). Writing uses FBX 7.4 (32-bit offsets), which every FBX SDK
since 2014 - including the one inside D5 Render - reads.
"""
from __future__ import annotations

import re
import struct
import zlib
from dataclasses import dataclass, field
from typing import Any, BinaryIO, Iterator

import numpy as np

MAGIC = b"Kaydara FBX Binary  \x00\x1a\x00"
FILE_ID = b"\x28\xb3\x2a\xeb\xb6\x24\xcc\xc2\xbf\xc8\xb0\x2a\xa9\x2b\xfc\xf1"
TIME_ID = b"1970-01-01 10:00:00:000"
FOOT_ID = b"\xfa\xbc\xab\x09\xd0\xc8\xd4\x66\xb1\x76\xfb\x83\x1c\xf7\x26\x7e"
FOOT_TAIL = b"\xf8\x5a\x8c\x6a\xde\xf5\xd9\x7e\xec\xe9\x0c\xe3\x75\x8f\x29\x0b"

_ARRAY_DTYPES = {"f": "<f4", "d": "<f8", "l": "<i8", "i": "<i4", "b": "?"}


class Raw(bytes):
    """Marks a property as FBX raw binary ('R')."""


@dataclass
class Prop:
    """Explicitly typed property (used when Python's type is ambiguous)."""
    code: str
    value: Any


@dataclass
class FBXNode:
    name: str
    props: list[Any] = field(default_factory=list)
    children: list["FBXNode"] = field(default_factory=list)

    # -- tree helpers --------------------------------------------------- #
    def add(self, name: str, *props: Any) -> "FBXNode":
        n = FBXNode(name, list(props))
        self.children.append(n)
        return n

    def find(self, name: str) -> "FBXNode | None":
        for c in self.children:
            if c.name == name:
                return c
        return None

    def find_all(self, name: str) -> Iterator["FBXNode"]:
        return (c for c in self.children if c.name == name)

    def value(self, name: str, default: Any = None) -> Any:
        n = self.find(name)
        if n is None or not n.props:
            return default
        return n.props[0]

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"FBXNode({self.name!r}, props={len(self.props)}, children={len(self.children)})"


# =========================================================================== #
# Reading
# =========================================================================== #
def read_fbx_tree(path: str) -> tuple[FBXNode, int]:
    """Return (root node, version). Detects binary vs ASCII."""
    with open(path, "rb") as f:
        head = f.read(len(MAGIC))
        if head == MAGIC:
            version = struct.unpack("<I", f.read(4))[0]
            data = f.read()
            return _BinaryReader(data, version).read_root(), version
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    return _read_ascii(text)


class _BinaryReader:
    def __init__(self, data: bytes, version: int) -> None:
        self.data = data
        self.version = version
        self.wide = version >= 7500
        self.base = len(MAGIC) + 4          # offsets in file are absolute

    def read_root(self) -> FBXNode:
        root = FBXNode("")
        pos = 0
        while True:
            node, pos = self._read_node(pos)
            if node is None:
                break
            root.children.append(node)
        return root

    def _read_node(self, pos: int) -> tuple[FBXNode | None, int]:
        d = self.data
        if self.wide:
            end, nprops, _plen = struct.unpack_from("<QQQ", d, pos)
            pos += 24
        else:
            end, nprops, _plen = struct.unpack_from("<III", d, pos)
            pos += 12
        name_len = d[pos]
        pos += 1
        if end == 0:
            return None, pos
        name = d[pos:pos + name_len].decode("utf-8", "replace")
        pos += name_len
        props = []
        for _ in range(nprops):
            val, pos = self._read_prop(pos)
            props.append(val)
        node = FBXNode(name, props)
        end_rel = end - self.base
        sentinel = 25 if self.wide else 13
        while pos < end_rel:
            if end_rel - pos == sentinel and not any(d[pos:end_rel]):
                pos = end_rel
                break
            child, pos = self._read_node(pos)
            if child is None:
                break
            node.children.append(child)
        return node, end_rel

    def _read_prop(self, pos: int) -> tuple[Any, int]:
        d = self.data
        code = chr(d[pos])
        pos += 1
        if code == "Y":
            return struct.unpack_from("<h", d, pos)[0], pos + 2
        if code == "C":
            return bool(d[pos]), pos + 1
        if code == "I":
            return struct.unpack_from("<i", d, pos)[0], pos + 4
        if code == "F":
            return struct.unpack_from("<f", d, pos)[0], pos + 4
        if code == "D":
            return struct.unpack_from("<d", d, pos)[0], pos + 8
        if code == "L":
            return struct.unpack_from("<q", d, pos)[0], pos + 8
        if code in ("S", "R"):
            n = struct.unpack_from("<I", d, pos)[0]
            pos += 4
            raw = d[pos:pos + n]
            pos += n
            if code == "S":
                return raw.decode("utf-8", "replace"), pos
            return Raw(raw), pos
        if code in _ARRAY_DTYPES:
            length, enc, clen = struct.unpack_from("<III", d, pos)
            pos += 12
            raw = d[pos:pos + clen]
            pos += clen
            if enc == 1:
                raw = zlib.decompress(raw)
            arr = np.frombuffer(raw, dtype=_ARRAY_DTYPES[code], count=length).copy()
            return arr, pos
        raise ValueError(f"Unknown FBX property type {code!r} at {pos}")


# -- ASCII ------------------------------------------------------------------- #
_TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|[{}:,]|[^\s{}:,"]+')


def _read_ascii(text: str) -> tuple[FBXNode, int]:
    lines = [ln.split(";", 1)[0] if not ln.lstrip().startswith(";") else "" for ln in text.splitlines()]
    tokens = _TOKEN.findall("\n".join(lines))
    root = FBXNode("")
    stack = [root]
    i = 0
    n = len(tokens)
    cur: FBXNode | None = None
    version = 7400
    while i < n:
        tok = tokens[i]
        if tok == "}":
            stack.pop()
            cur = None
            i += 1
            continue
        if i + 1 < n and tokens[i + 1] == ":":
            cur = FBXNode(tok)
            stack[-1].children.append(cur)
            i += 2
            # values until newline-free sequence ends with '{' or next 'name:'
            while i < n:
                t = tokens[i]
                if t == "{":
                    stack.append(cur)
                    i += 1
                    break
                if t == ",":
                    i += 1
                    continue
                if t == "}" or (i + 1 < n and tokens[i + 1] == ":"):
                    break
                if t.startswith("*"):     # array: *N { a: 1,2,3 }
                    i += 1
                    if i < n and tokens[i] == "{":
                        i += 1
                    if i + 1 < n and tokens[i + 1] == ":":
                        i += 2
                    vals = []
                    while i < n and tokens[i] != "}":
                        if tokens[i] != ",":
                            vals.append(tokens[i])
                        i += 1
                    i += 1
                    cur.props.append(_ascii_array(vals))
                    continue
                cur.props.append(_ascii_scalar(t))
                i += 1
            if cur.name == "FBXVersion" and cur.props:
                version = int(cur.props[0])
            continue
        i += 1
    return root, version


def _ascii_scalar(t: str) -> Any:
    if t.startswith('"'):
        return t[1:-1].replace("&quot;", '"').replace("&cr;", "\r").replace("&lf;", "\n")
    try:
        if re.fullmatch(r"[-+]?\d+", t):
            return int(t)
        return float(t)
    except ValueError:
        return t


def _ascii_array(vals: list[str]) -> np.ndarray:
    if any(("." in v or "e" in v.lower()) for v in vals):
        return np.array([float(v) for v in vals], dtype=np.float64)
    return np.array([int(v) for v in vals], dtype=np.int64)


# =========================================================================== #
# Writing
# =========================================================================== #
def _encode_prop(v: Any, compress: bool) -> bytes:
    if isinstance(v, Prop):
        code, val = v.code, v.value
        if code in _ARRAY_DTYPES:
            return _encode_array(code, np.asarray(val), compress)
        return code.encode() + struct.pack({"Y": "<h", "C": "<?", "I": "<i", "F": "<f",
                                             "D": "<d", "L": "<q"}[code], val)
    if isinstance(v, Raw):
        return b"R" + struct.pack("<I", len(v)) + bytes(v)
    if isinstance(v, bool):
        return b"C" + struct.pack("<?", v)
    if isinstance(v, (int, np.integer)):
        iv = int(v)
        if -(2 ** 31) <= iv < 2 ** 31:
            return b"I" + struct.pack("<i", iv)
        return b"L" + struct.pack("<q", iv)
    if isinstance(v, (float, np.floating)):
        return b"D" + struct.pack("<d", float(v))
    if isinstance(v, str):
        b = v.encode("utf-8")
        return b"S" + struct.pack("<I", len(b)) + b
    if isinstance(v, (bytes, bytearray)):
        return b"S" + struct.pack("<I", len(v)) + bytes(v)
    if isinstance(v, np.ndarray):
        return _encode_array(_array_code(v), v, compress)
    raise TypeError(f"Cannot encode FBX property {type(v)}")


_COMPRESSED: dict[int, bytes] = {}


def _encode_array(code: str, arr: np.ndarray, compress: bool) -> bytes:
    data = np.ascontiguousarray(arr, dtype=_ARRAY_DTYPES[code]).tobytes()
    enc = 0
    if compress and len(data) > 128:
        comp = _COMPRESSED.get(id(arr))
        if comp is None:
            comp = zlib.compress(data, 6)
        if len(comp) < len(data):
            data, enc = comp, 1
    return code.encode() + struct.pack("<III", len(arr), enc, len(data)) + data


def _array_code(v: np.ndarray) -> str:
    if v.dtype.kind == "f":
        return "f" if v.dtype == np.float32 else "d"
    if v.dtype.kind == "b":
        return "b"
    return "l" if v.dtype.itemsize == 8 else "i"


def _precompress(root: "FBXNode") -> None:
    """Deflate all big arrays in parallel (zlib releases the GIL)."""
    from concurrent.futures import ThreadPoolExecutor
    arrays: list[tuple[np.ndarray, str]] = []
    stack = [root]
    while stack:
        n = stack.pop()
        for p in n.props:
            if isinstance(p, np.ndarray) and p.nbytes > 4096:
                arrays.append((p, _array_code(p)))
        stack.extend(n.children)

    def job(item):
        arr, code = item
        return id(arr), zlib.compress(np.ascontiguousarray(arr, dtype=_ARRAY_DTYPES[code]).tobytes(), 6)
    with ThreadPoolExecutor() as ex:
        for k, v in ex.map(job, arrays):
            _COMPRESSED[k] = v


def write_fbx_tree(path: str | BinaryIO, root: FBXNode, version: int = 7400,
                   compress: bool = True) -> int:
    """Write the node tree as binary FBX. Returns the file size in bytes."""
    if compress:
        _precompress(root)
    out = bytearray()
    out += MAGIC + struct.pack("<I", version)
    wide = version >= 7500
    sentinel = b"\0" * (25 if wide else 13)

    def write_node(node: FBXNode, is_last: bool) -> None:
        start = len(out)
        props = b"".join(_encode_prop(p, compress) for p in node.props)
        name = node.name.encode()
        hdr_size = (24 if wide else 12) + 1 + len(name)
        out.extend(b"\0" * hdr_size)
        out[start + hdr_size - len(name):start + hdr_size] = name
        out.extend(props)
        if node.children:
            for i, c in enumerate(node.children):
                write_node(c, i == len(node.children) - 1)
            out.extend(sentinel)
        elif not node.props and not is_last:
            out.extend(sentinel)
        end = len(out)
        fmt = "<QQQ" if wide else "<III"
        struct.pack_into(fmt, out, start, end, len(node.props), len(props))
        out[start + (24 if wide else 12)] = len(name)

    for i, c in enumerate(root.children):
        write_node(c, i == len(root.children) - 1)
    out += sentinel
    # footer
    out += FOOT_ID + b"\0" * 4
    pad = ((len(out) + 15) & ~15) - len(out)
    out += b"\0" * (pad or 16)
    out += struct.pack("<I", version) + b"\0" * 120 + FOOT_TAIL

    _COMPRESSED.clear()
    if isinstance(path, (str, bytes)) or hasattr(path, "__fspath__"):
        with open(path, "wb") as f:
            f.write(out)
    else:
        path.write(out)
    return len(out)
