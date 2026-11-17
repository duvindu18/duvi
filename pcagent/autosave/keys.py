"""Parse key strings like "ctrl+s" or "esc" into Windows virtual-key codes."""
from __future__ import annotations

VK = {
    "ctrl": 0x11, "control": 0x11, "shift": 0x10, "alt": 0x12, "win": 0x5B,
    "esc": 0x1B, "escape": 0x1B, "enter": 0x0D, "return": 0x0D, "tab": 0x09,
    "space": 0x20, "backspace": 0x08, "delete": 0x2E, "del": 0x2E,
    "home": 0x24, "end": 0x23, "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
}
VK.update({f"f{i}": 0x6F + i for i in range(1, 25)})
MODIFIERS = {0x11, 0x10, 0x12, 0x5B}


def parse(combo: str) -> list[int]:
    """'ctrl+shift+s' -> [VK_CONTROL, VK_SHIFT, ord('S')]."""
    codes = []
    for part in combo.lower().replace(" ", "").split("+"):
        if not part:
            raise ValueError(f"bad key combo: {combo!r}")
        if part in VK:
            codes.append(VK[part])
        elif len(part) == 1 and part.isalnum():
            codes.append(ord(part.upper()))
        else:
            raise ValueError(f"unknown key {part!r} in {combo!r}")
    return codes
