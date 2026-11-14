# CADView: an offline CAD and 3D viewer for Android and iOS

CADView opens CAD drawings and 3D models on a phone with **no internet, no account and no uploads**.
It is a TypeScript + three.js app packaged as native Android and iOS apps with [Capacitor](https://capacitorjs.com).
The whole app ships inside the APK/IPA, and the Android build doesn't even request the INTERNET permission.

## Gestures

| | 2D drawings | 3D models |
|---|---|---|
| One finger | pan, with fling momentum | orbit |
| Pinch | zoom around the point between your fingers | zoom toward what's under your fingers |
| Twist | rotate (can be locked; the compass resets it) | spin |
| Two fingers drag | pan | pan |
| Double-tap | zoom in ×2 there | fly in and re-centre the orbit there |
| Two-finger tap | zoom out ×2 | zoom out ×2 |
| Long-press | menu: measure from here, add a note, zoom, copy coordinates | same |
| Long-press while measuring | **magnifier loupe** for precise placement; a haptic tick on each snap | same |
| Swipe a panel down | close it | close it |

Taps snap to real corners, line ends, midpoints, circle centres and quadrants. In 3D they snap to vertices on the surface you touched (never through walls).

## Features

- **Fully offline library.** Opened files are kept on the device with thumbnails, and the last view, notes and measurements are restored when you reopen one.
- **Measure** distance (Δx/Δy, or height difference in 3D) and area plus perimeter. Units are set per file: mm, cm, m, in, or ft with feet-inches.
- **Pinned notes** that can be shared as text, and **share a marked-up image** through the phone's share sheet.
- **Revision compare** (DXF): added lines show green, removed red, unchanged grey, each toggleable. Matching is by geometry, so re-saves and reordering don't count as changes.
- **Find text** (room numbers, tags), including block attributes.
- **Section cuts** in 3D (across, height or depth), plus standard views and "stand model up" for Z-up exports.
- **Site mode**: high contrast for sunlight, with larger targets.
- Follows the system **dark/light** theme. On light backgrounds pale CAD colours are darkened automatically so yellow and cyan stay readable.
- **Open with CADView** from file managers, email, WhatsApp or Drive (Android intent filters and iOS document types).

## Built for big files

Measured in headless Chromium on a laptop CPU (`e2e/bigfiles.cjs`; GPU rendering there is software-emulated, so frame rates on a real phone GPU are much better):

| File | Opens in | Longest UI-thread pause while loading | Snap tap |
|---|---|---|---|
| DXF, 53 MB: 806k entities, 3.6M segments, 115k texts | **2.8 s** | 34 ms | 0.05 ms |
| STL, 196 MB: 3.9M triangles | **4.1 s** | 179 ms | 0.35 ms |

With level of detail, the 53 MB plan draws 691k segments and 0 glyphs at full view, and 69k segments when zoomed in 8× (instead of 3.6M segments plus 1.8M glyph triangles every frame).

| Technique | Effect |
|---|---|
| **Streaming byte-level DXF reader** in a Web Worker | 53 MB / 806k entities parses in ~2 s on a laptop CPU. Memory is a small multiple of the output, not 30-40× the file like object-based parsers. The UI keeps animating while it loads, and loading can be cancelled. |
| Geometry goes straight into **fixed-size typed-array chunks** | no doubling or final copy; handed to the GPU with zero-copy transfer |
| **Adaptive arc tessellation** from the drawing extents | half the segments of a fixed 64-per-circle approach, still smooth when zoomed in |
| **Spatial tiles + length-sorted level of detail** | off-screen tiles are culled when zoomed in; sub-pixel segments are skipped when zoomed out; one draw call per tile |
| **GPU-instanced text** from one glyph atlas, tiled and sorted by height | only labels big enough to read are drawn; off-screen tiles are culled |
| **Uniform-grid snap index** | snapping is a cell lookup instead of a scan of millions of points |
| **BVH ray casting** (three-mesh-bvh), built in the worker for OBJ/STL/PLY | instant taps on multi-million-triangle models |
| Mesh **merging per part and material**, edges added progressively | thousands of SketchUp components become a handful of draw calls |
| **Render on demand** plus **adaptive resolution while moving** | no battery drain when idle; heavy scenes drop resolution mid-gesture and sharpen the moment fingers stop |
| Survey coordinates **re-centred** before the GPU | no float32 jitter on drawings at x ≈ 500 000 |

## Formats

| Format | Status |
|---|---|
| DXF (ASCII, R12–2018+) | ✅ LINE, (LW)POLYLINE with bulges/arcs, 3D polylines, polyface and polygon meshes, CIRCLE, ARC, ELLIPSE, SPLINE (rational, de Boor), SOLID/TRACE/3DFACE, LEADER, TEXT/MTEXT/ATTRIB with alignment, INSERT (nested, rotated, scaled, arrays), DIMENSION. Handles OCS/extrusion (mirrored entities), layer on/off/frozen, ACI and true colour, ByLayer/ByBlock, code pages and `\U+` escapes. Paper-space layouts are skipped. Anything not drawn yet (e.g. HATCH) is **listed in File info**, never silently dropped. |
| GLB/glTF (incl. Draco, meshopt, KTX2), OBJ, STL, PLY, DAE, 3MF | ✅ 3D. Decoders are bundled locally. |
| **SKP** (SketchUp) | ⚠️ Trimble's SDK is desktop-only. The app explains how to export from SketchUp (.dae keeps groups and materials). |
| **DWG** | ⚠️ Needs a decoder (see "Decisions needed"). The app asks the user to save as DXF for now. |
| Binary DXF | ❌ Not yet. The app says so. |

## Run, test, build

```bash
cd cadview
npm install
npm run dev                         # open the printed URL on your phone (same Wi-Fi)
npm test                            # unit tests: DXF geometry, OCS, blocks, bulges, diff, snap index
npm run build && npx vite preview --port 4173 &
node e2e/gestures.cjs http://localhost:4173/ /tmp     # real multi-touch: pinch, twist, fling, long-press, loupe…
node e2e/screens.cjs  http://localhost:4173/ /tmp     # layout check on 6 screen sizes / orientations
npx vite-node scripts/make-big.ts /tmp 4              # 53 MB DXF + 196 MB STL stress files
node e2e/bigfiles.cjs http://localhost:4173/ /tmp/big-city.dxf /tmp/big-terrain.stl
```

### Phone apps

The native projects are already generated in `android/` and `ios/`.

```bash
npm run cap:android   # builds the web bundle, syncs it, opens Android Studio → Run / Build APK
npm run cap:ios       # same for Xcode (needs a Mac) → Run / Archive
```

## Code map

```
src/cad/dxf.ts        streaming DXF reader → chunked line buffers, text, snap points
src/cad/tiles.ts      spatial tiles + length classes for level of detail
src/cad/diff.ts       revision compare (53-bit geometric hashes, multiset matching)
src/cad/snapgrid.ts   uniform-grid nearest-point index
src/worker.ts         parsing, compare, mesh parsing + BVH + edges, off the UI thread
src/render/controls.ts touch gesture engine (pan/pinch/twist/fling/double-tap/long-press)
src/render/viewer.ts  renderer, adaptive resolution, picking, loupe, sections, labels
src/render/text.ts    instanced glyph-atlas text with size-based culling
src/render/scene.ts   scene building for 2D tiles and 3D models (glTF/DAE/3MF on the main thread)
src/ui/*              icons, bottom sheet, popover, loading, haptics
src/main.ts           app: library, tools, sheets, compare, notes, share
```

## Decisions needed

1. **DWG decoder.** LibreDWG compiled to WebAssembly is free and works offline, but it is **GPL**, so the whole app would have to be open source. The ODA Drawings SDK is commercial (paid membership), with native Android and iOS builds.
2. **SKP:** keep the export-from-SketchUp workflow, or add an optional cloud converter. With a converter the app is no longer offline for SKP.

## Roadmap

- [ ] DWG (once decided), binary DXF, HATCH fills, linetypes and line weights
- [ ] 3D level of detail for 10M+ triangle models
- [ ] Calibrate scale from a known dimension; angle and polyline-length measuring
- [ ] PDF report of notes and measurements; photos attached to notes
- [ ] AR placement at real scale (ARCore/ARKit)
