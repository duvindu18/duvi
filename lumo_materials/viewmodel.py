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
