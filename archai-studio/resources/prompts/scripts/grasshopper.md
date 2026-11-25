## Target: Grasshopper script component in Rhino 8 (Python 3)
- Rhino 8's **Script** component with the Python 3 (CPython) language. Start with `#! python3`. To ask for a package, add `# r: package-name` lines at the top (for example `# r: numpy`).
- Inputs and outputs are the component's parameters. Refer to inputs by their names (state them in the header comment with their type hints, such as Curve, int, float or list access), and assign each output variable. Say in the Notes which inputs need **List Access** or **Tree Access**.
- Use `import Rhino.Geometry as rg` for geometry, and `import rhinoscriptsyntax as rs` only where it is simpler. Return RhinoCommon geometry (Brep, Mesh, Curve, Point3d) to outputs. Don't add objects to the Rhino document from Grasshopper unless the user asks to bake.
- Units follow the Rhino document. Assume **millimetres** for architecture and say so. Read tolerances from `Rhino.RhinoDoc.ActiveDoc.ModelAbsoluteTolerance` when needed.
- Guard against missing inputs (`if crv is None: ...`) so the component shows a clean warning, not an exception. Use `ghenv.Component.AddRuntimeMessage(...)` with `Grasshopper.Kernel.GH_RuntimeMessageLevel.Warning` for warnings.
- Keep it fast: avoid adding to the document inside loops, and prefer RhinoCommon over rhinoscriptsyntax inside heavy loops.

### Known-good example: louvre fins along a curve
```python
#! python3
"""Vertical louvre fins along a base curve.
Inputs:  crv (Curve, item), count (int, item), depth (float, mm), height (float, mm)
Output:  fins (list of Brep)
Rhino 8, Python 3. Units: document units (mm assumed)."""
import Rhino.Geometry as rg
import Grasshopper

fins = []
if crv is None or not count or count < 2:
    ghenv.Component.AddRuntimeMessage(
        Grasshopper.Kernel.GH_RuntimeMessageLevel.Warning,
        "Connect a curve and a count of 2 or more.")
else:
    params = crv.DivideByCount(int(count) - 1, True)  # count fins, including both ends
    for t in params:
        base = crv.PointAt(t)
        tangent = crv.TangentAt(t)
        normal = rg.Vector3d.CrossProduct(tangent, rg.Vector3d.ZAxis)
        normal.Unitize()
        profile = rg.Line(base, base + normal * depth).ToNurbsCurve()
        surface = rg.Surface.CreateExtrusion(profile, rg.Vector3d(0, 0, height))
        if surface:
            fins.append(surface.ToBrep())
```
