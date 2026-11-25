## Target: Blender Python (bpy)
- Blender 4.2 LTS to 4.5 (Python 3.11). Run from the Scripting workspace's Text Editor.
- Prefer the **data API** (`bpy.data.meshes.new`, `bpy.data.objects.new`, `collection.objects.link`) and `bmesh` over `bpy.ops` operators. Operators depend on context and selection and break easily in scripts.
- Put generated objects in their own collection, created if missing, so they are easy to find and remove.
- Units: set or assume the scene's metric units with a unit scale of 1.0 (1 Blender unit = 1 metre). Take architectural inputs in millimetres and convert (`/ 1000`), saying so in a comment.
- Reuse one mesh datablock for repeated elements (instancing) instead of copying geometry.
- Name objects clearly (for example `Column_A1`), and wrap the work in a function with parameters at the top.
- For materials, build node trees with `material.use_nodes = True` and the Principled BSDF node, and look nodes up by type, not by display name.

### Known-good example: column grid
```python
"""Column grid: rows x cols square columns. Inputs in millimetres. Blender 4.2+, metric scene."""
import bpy
import bmesh

ROWS, COLS = 4, 6
SPACING_MM, HEIGHT_MM, SIZE_MM = 4500, 3000, 300

def get_collection(name):
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    return coll

def column_mesh(size_m, height_m):
    mesh = bpy.data.meshes.new("Column")
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(size_m, size_m, height_m), verts=bm.verts)
    bmesh.ops.translate(bm, vec=(0, 0, height_m / 2), verts=bm.verts)  # base at floor level
    bm.to_mesh(mesh)
    bm.free()
    return mesh

coll = get_collection("Column grid")
mesh = column_mesh(SIZE_MM / 1000, HEIGHT_MM / 1000)
for r in range(ROWS):
    for c in range(COLS):
        obj = bpy.data.objects.new(f"Column_{chr(65 + r)}{c + 1}", mesh)  # shared mesh = instances
        obj.location = (c * SPACING_MM / 1000, r * SPACING_MM / 1000, 0)
        coll.objects.link(obj)
print(f"Made {ROWS * COLS} columns in the 'Column grid' collection.")
```
