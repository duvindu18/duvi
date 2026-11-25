## Target: pyRevit button script (script.py)
- pyRevit 4.8+ / 5.x in Revit 2023 to 2026. Default engine is **IronPython 2.7**, so no f-strings. Use `"{}".format()` and start with `# -*- coding: utf-8 -*-`. Put `u""` before strings that contain non-ASCII text, such as `u"m²"`. If the user asks for CPython, put `#! python3` on the first line instead.
- Bundle metadata at the top: `__title__ = "Short\nTitle"`, `__doc__ = "One-line tooltip."`, and optionally `__author__`.
- Use pyRevit helpers: `from pyrevit import revit, DB, forms, script`. `doc = revit.doc`, `uidoc = revit.uidoc`, `output = script.get_output()`.
- Selection: `revit.get_selection()`. Pickers: `forms.select_views()`, `forms.SelectFromList.show(...)`. Messages: `forms.alert("...", exitscript=True)`.
- Changes go inside `with revit.Transaction("Readable name"):`, so they undo as one step.
- Output tables: `output.print_md("## Heading")` and `output.print_table(table_data=rows, columns=[...])`. Clickable element ids: `output.linkify(el.Id)`.
- Units: Revit internal units are feet. Convert with `DB.UnitUtils.ConvertFromInternalUnits(v, DB.UnitTypeId.SquareMeters)` (Revit 2021+).

### Known-good example
```python
# -*- coding: utf-8 -*-
"""Lists placed rooms with their areas in m², largest first."""
__title__ = "Room\nAreas"
__doc__ = "Lists placed rooms with their areas in m²."

from pyrevit import revit, DB, forms, script

doc = revit.doc
output = script.get_output()

rooms = (DB.FilteredElementCollector(doc)
         .OfCategory(DB.BuiltInCategory.OST_Rooms)
         .WhereElementIsNotElementType()
         .ToElements())

rows = []
for room in rooms:
    if room.Area <= 0:
        continue
    name_param = room.get_Parameter(DB.BuiltInParameter.ROOM_NAME)
    name = name_param.AsString() if name_param else u""
    area = DB.UnitUtils.ConvertFromInternalUnits(room.Area, DB.UnitTypeId.SquareMeters)
    rows.append((room.Number, name, area))

if not rows:
    forms.alert(u"No placed rooms found in this model.", exitscript=True)

rows.sort(key=lambda r: r[2], reverse=True)
total = sum(r[2] for r in rows)
output.print_md(u"## Room areas")
output.print_table(
    table_data=[[n, nm, u"{:.2f}".format(a)] for n, nm, a in rows],
    columns=[u"Number", u"Name", u"Area (m²)"]
)
output.print_md(u"**Total: {:.2f} m²**".format(total))
```
