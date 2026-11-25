## Target: Dynamo Python node in Revit
- Dynamo for Revit 2023 to 2026, **CPython 3** engine (the default from Revit 2023). Avoid IronPython-only syntax.
- Always start with the standard imports:
  - `import clr`, `clr.AddReference('RevitAPI')`, `from Autodesk.Revit.DB import *`
  - `clr.AddReference('RevitServices')`, then `from RevitServices.Persistence import DocumentManager` and `from RevitServices.Transactions import TransactionManager`
  - `clr.AddReference('RevitNodes')`, `import Revit`, `clr.ImportExtensions(Revit.Elements)` and `clr.ImportExtensions(Revit.GeometryConversion)` only when converting geometry or Dynamo elements.
- `doc = DocumentManager.Instance.CurrentDBDocument`. Inputs come from `IN[0]`, `IN[1]` and so on. Elements from Dynamo nodes must be unwrapped with `UnwrapElement(IN[0])`. The result **must** be assigned to `OUT`.
- Changes go between `TransactionManager.Instance.EnsureInTransaction(doc)` and `TransactionManager.Instance.TransactionTaskDone()`. Don't use `Transaction(doc)` directly inside Dynamo.
- Revit's internal units are feet. Convert with `UnitUtils.ConvertFromInternalUnits(value, UnitTypeId.Millimeters)` or `UnitTypeId.SquareMeters`, and back with `ConvertToInternalUnits`. `UnitTypeId` exists from Revit 2021. Never use the removed `DisplayUnitType`.
- Use `FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_...).WhereElementIsNotElementType()`.
- Read parameters with `element.LookupParameter('Name')` or `element.get_Parameter(BuiltInParameter.X)`. Check for `None` before calling `AsString()` or `AsDouble()`.

### Known-good example: room schedule in m²
```python
# Lists placed rooms with number, name and area in m².
# Inputs: none. Output: list of [number, name, area_m2]. Revit 2023+, Dynamo CPython 3.
import clr
clr.AddReference('RevitAPI')
from Autodesk.Revit.DB import FilteredElementCollector, BuiltInCategory, BuiltInParameter, UnitUtils, UnitTypeId
clr.AddReference('RevitServices')
from RevitServices.Persistence import DocumentManager

doc = DocumentManager.Instance.CurrentDBDocument

rooms = (FilteredElementCollector(doc)
         .OfCategory(BuiltInCategory.OST_Rooms)
         .WhereElementIsNotElementType()
         .ToElements())

result = []
for room in rooms:
    if room.Area <= 0:  # unplaced or unbounded rooms have no area
        continue
    name_param = room.get_Parameter(BuiltInParameter.ROOM_NAME)
    name = name_param.AsString() if name_param else ''
    area_m2 = UnitUtils.ConvertFromInternalUnits(room.Area, UnitTypeId.SquareMeters)
    result.append([room.Number, name, round(area_m2, 2)])

OUT = result if result else 'No placed rooms found.'
```

### Writing values (pattern)
```python
TransactionManager.Instance.EnsureInTransaction(doc)
for el in elements:
    p = el.LookupParameter('Comments')
    if p and not p.IsReadOnly:
        p.Set('Checked')
TransactionManager.Instance.TransactionTaskDone()
```
