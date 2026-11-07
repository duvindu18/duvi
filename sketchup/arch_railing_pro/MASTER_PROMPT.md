# Master prompt: ArchRailing Pro

The prompt this extension was built from, corrected where the original would mislead a model (for example, `Module.new(:ArchRailingPro)` is not valid namespacing; a plain `module ArchRailingPro` is).

```text
Act as a Principal SketchUp Extension Developer and Ruby architect. Write a complete,
production-ready SketchUp extension packaged as an .rbz, named "ArchRailing Pro": a
parametric railing generator for balustrades, glass guards, cable rails and fences
along any user-selected path.

1. CORE FUNCTION
- Path: take the selected Edges (and whole Curves/ArcCurves when one edge of them is
  selected). Order them into chains by walking vertex adjacency; split at junctions of
  3+ edges; detect closed loops. Remove duplicate and collinear points. Refuse vertical
  segments and zero-length paths with a clear message.
- Distribution: place posts by arc length (along the slope, or in plan). Modes: fit to
  length (equal bays no wider than the spacing) and fixed from start. Put posts at path
  ends, at plan corners sharper than a threshold, and at slope breaks (stair to landing).
  Each run between those points is spaced independently.
- Slopes: posts and balusters stay plumb and unscaled; rails, glass and panels follow
  the path. Rails keep their true thickness on slopes (section height x 1/cos(slope)).
- Parts: start/end/corner/intermediate posts (toggle each), top rail, bottom rail,
  infill (none, balusters, glass with clamps, solid/perforated panel, horizontal rails
  or cables), and a handrail on brackets. Round or rectangular profiles throughout.
- Offsets: horizontal (mitred parallel offset in plan, + = left of travel) and vertical.
  Refuse an offset larger than a curve radius.
- Components: let the user replace the built-in post, baluster and clamp with any
  component definition in the model (origin at base centre, red axis along the path).

2. UI (UI::HtmlDialog)
- One floating panel: live elevation preview with stats beside tabbed controls
  (Layout, Posts, Rails, Infill, Finish); a gallery of 31 ready-made railings with a
  thumbnail each, filterable by category; save/delete user presets.
- Create from selection, Update selected, Change path, and a Live update switch that
  rebuilds the selected railing on every change (debounced).
- The panel follows the SketchUp selection through a SelectionObserver: selecting a
  railing loads its settings.
- Style: SketchUp Tools UI Kit. Black and white, one blue (#0B5CFF) for active,
  selected, primary and focus; Poppins headings, Space Mono text; square hairline
  frames; no shadows; light and dark themes; line icons on a 24 px grid.

3. NON-DESTRUCTIVE EDITING
- Store the path (in the group's local coordinates) and all parameters as JSON in an
  AttributeDictionary on the railing group. Regenerate from stored data so the railing
  survives deletion of its source edges and keeps user moves and rotations.
- Make shared groups unique before regenerating. Close an edit context that is inside
  the railing before rebuilding it.

4. ENGINEERING RULES
- Wrap every create/update in model.start_operation(name, true) ... commit_operation,
  aborting on error, so each action is one undo step.
- Reuse ComponentDefinitions for every repeated rigid part, keyed by role and size;
  remove unused built-in definitions after a rebuild.
- Build continuous parts as PolygonMesh sweeps with consistent outward winding and
  end caps; soften coplanar and (for round profiles) smooth edges.
- Use Geom::Transformation.axes with a vertical Z for every placed part: no scaling of
  rigid parts.
- Validate and clamp every parameter from the UI. Show PathError/ParamError messages
  with UI.messagebox; log unexpected errors to the Ruby Console.
- Keep all code inside `module ArchRailingPro`.

5. FILES
- arch_railing_pro.rb (SketchupExtension loader)
- arch_railing_pro/main.rb (menus, toolbar, context menu, observers, operations)
- arch_railing_pro/generator.rb (path maths, layout, sweeps, placement)
- arch_railing_pro/ui_dialog.rb (HtmlDialog bridge)
- arch_railing_pro/defaults.rb (schema, validation, presets)
- arch_railing_pro/ui/*, arch_railing_pro/icons/*

6. OUTPUT
Give every file in full, then how to zip the loader and folder into an .rbz and install
it with Extension Manager > Install Extension.
```
