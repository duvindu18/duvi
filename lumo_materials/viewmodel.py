"""UI logic without Qt (so it can be unit-tested headless)."""
from __future__ import annotations

import math
from dataclasses import dataclass, field


def page_window(page: int, pages: int, width: int = 7) -> list[int | None]:
    """Page numbers (0-based) for the pager; None = ellipsis. First and last page are always shown."""
    if pages <= width:
        return list(range(pages))
    if page <= 2:
        lo, hi = 1, 3
    elif page >= pages - 3:
        lo, hi = pages - 4, pages - 2
    else:
        lo, hi = page - 1, page + 1
    out: list[int | None] = [0]
    if lo > 1:
        out.append(None)
    out += list(range(lo, hi + 1))
    if hi < pages - 2:
        out.append(None)
    out.append(pages - 1)
    return out


def grid_layout(available: int, min_card: int = 210, gap: int = 12, max_cols: int = 12) -> tuple[int, int]:
    """(columns, card width) that fill the available width exactly."""
    cols = max(1, min(max_cols, (available + gap) // (min_card + gap)))
    width = (available - gap * (cols - 1)) // cols
    return cols, max(120, width)


@dataclass
class LibraryFilter:
    view: str = "library"          # library | favourites | recent
    search: str = ""
    category: str | None = None
    tags: list[str] = field(default_factory=list)
    sort: str = "recent"
    page: int = 0
    page_size: int = 24

    def query_args(self) -> dict:
        return dict(search=self.search, category=self.category, tags=self.tags,
                    favourites=self.view == "favourites", sort=self.sort,
                    recent_days=30 if self.view == "recent" else None)

    def clamp_page(self, total: int) -> None:
        pages = max(1, math.ceil(total / self.page_size))
        self.page = max(0, min(pages - 1, self.page))

    def slice(self, items: list) -> list:
        self.clamp_page(len(items))
        a = self.page * self.page_size
        return items[a:a + self.page_size]

    def title(self) -> str:
        if self.category:
            return self.category
        return {"favourites": "Favourites", "recent": "Recently added"}.get(self.view, "All materials")


def renderer_chain(choice: str, windows: bool) -> list[str]:
    """Preview renderers to try, best first. Direct3D needs Windows; every chain ends with the CPU preview."""
    gpu = ["d3d12", "d3d11", "opengl"] if windows else ["opengl"]
    if choice == "cpu":
        return ["cpu"]
    if choice in gpu:
        return gpu[gpu.index(choice):] + ["cpu"]
    return gpu + ["cpu"]


# ---------------------------------------------------------------- 3D preview framing (shared by all viewers)
FOV_Y = 32.0                 # degrees
SPHERE_SCALE = {"sphere": 1.0, "both": 0.95}
PLANE_SCALE = {"plane": 0.6, "both": 0.62}     # the plane mesh is 3.2 units wide before scaling
BOTH_OFFSET = 1.15           # x of the sphere (-) and the plane (+) in "both"
MARGIN = 1.15                # free space around the objects


def camera_distance(shape: str, aspect: float, zoom: float = 1.0) -> float:
    """Distance at which the shown objects fit the viewport with a margin, for any width / height."""
    import math
    t = math.tan(math.radians(FOV_Y / 2))
    aspect = max(0.2, float(aspect))
    if shape == "both":
        plane_half = 1.6 * PLANE_SCALE["both"] * 1.3                 # corners of the turned plane
        half_w = BOTH_OFFSET + max(1.06 * SPHERE_SCALE["both"], plane_half)
        half_h = max(1.06 * SPHERE_SCALE["both"], plane_half)
        depth = 1.0
    elif shape == "plane":
        half_w = half_h = 1.6 * PLANE_SCALE["plane"] * 1.15     # corners when turned towards the camera
        depth = 0.6
    else:
        half_w = half_h = 1.06                                     # radius + displacement
        depth = 1.06
    d = max(half_h * MARGIN / t, half_w * MARGIN / (t * aspect)) + depth * 0.5
    return d / max(0.3, float(zoom))
