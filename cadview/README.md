# CADView: an offline CAD and 3D viewer for Android and iOS

CADView opens CAD drawings and 3D models on a phone with **no internet, no account and no uploads**.
It is a web app (TypeScript + three.js) that ships inside a native Android/iOS app through [Capacitor](https://capacitorjs.com).
All parsing and rendering runs on the device.

## Features that set it apart

| Feature | Why it matters on site |
|---|---|
| **Fully offline, no login** | Basements, rural sites and plane trips. Files you open are kept on the device and reopen with no signal. |
| **Revision compare** (DXF) | Open rev A, then compare it with rev B. Added lines show green, removed lines red, unchanged grey, with an "only changes" filter. Matching is by geometry, so a re-save or reordering doesn't count as a change. |
| **Find text in drawings** | Search "203" or "DB-2" and the view jumps to that room, door tag or note. |
| **Snapping measurements** | Distance (with Δx/Δy or height) and area/perimeter. Points snap to real corners and line ends. Measurements are saved with the file. |
| **Pinned notes** | Drop numbered notes on the drawing or model, list them, export them as text, and share a marked-up PNG through the phone's share sheet. |
| **Section cuts** (3D) | Slice a building horizontally to see a floor plan, or along X/Z. |
| **Site mode** | Black-on-white high contrast for direct sunlight, with larger buttons for gloved hands. |
| **Private by design** | Files never leave the device. That matters for NDAs and security-sensitive buildings. |
| **Battery-friendly** | The view only redraws when something changes, never as a constant 60 fps loop. |

## Formats

| Format | Status |
|---|---|
| DXF (ASCII) | ✅ Lines, polylines (including arcs/bulges), circles, arcs, ellipses, splines, solids, 3D faces, blocks/INSERT (rotation, scale, arrays), dimensions, TEXT/MTEXT, layers and colours. Anything not drawn yet (e.g. HATCH) is **reported** when the file opens, never hidden silently. |
| glTF / GLB, OBJ, STL, DAE, PLY, 3MF | ✅ 3D. Edges are outlined like in SketchUp, and parts/components can be toggled. |
| **SKP** (SketchUp) | ⚠️ Trimble's SDK is desktop-only, so a .skp can't be read on a phone. The app explains how to export from SketchUp (.dae keeps components and materials). |
| **DWG** (AutoCAD) | ⚠️ Needs a decoder. See "Decisions needed" below. Until then the app tells the user to save as DXF. |
| Binary DXF | ❌ Not yet. The app says so and asks for ASCII DXF. |

## Run it

```bash
cd cadview
npm install
npm run dev          # open the printed URL on your phone (same Wi-Fi)
npm test             # unit tests (DXF geometry, blocks, bulges, revision diff)
npx vite-node scripts/make-samples.ts   # writes demo files to samples/
```

## Build the phone apps

```bash
npm run build
npx cap add android && npx cap add ios   # first time only: creates the native projects
npm run cap:android  # opens Android Studio → Run / Build APK
npm run cap:ios      # opens Xcode (needs a Mac) → Run / Archive
```

The whole web bundle is copied into the app, so it runs offline from the first launch.

## Code map

```
src/cad/dxf.ts       DXF → primitives (pure TS, no three.js), with block expansion, arcs, bulges, splines, text
src/cad/diff.ts      revision compare: order- and direction-independent geometric signatures
src/parse.worker.ts  parses DXF off the UI thread, so big files don't freeze the screen
src/build.ts         primitives → merged GPU line batches (one per layer and colour); 3D loaders
src/viewer.ts        renderer, camera fit, snapping, section planes, labels pinned to the model
src/library.ts       on-device storage (IndexedDB): files, notes and measurements per file
src/main.ts          UI: tools, sheets, compare, find, notes, site mode, snapshot sharing
```

Large survey-grid coordinates (e.g. x ≈ 500 000) are re-centred before reaching the GPU, so the drawing doesn't jitter.

## Decisions needed

1. **DWG decoder**
   - *LibreDWG compiled to WebAssembly* (e.g. the `@mlightcad/libredwg-web` package). It is free and runs offline, but it is **GPL**, so the whole app would have to be open source under GPL.
   - *ODA Drawings SDK*. Commercial (paid yearly membership), with native Android/iOS builds, and the most accurate option.
2. **SKP**: keep the export-from-SketchUp workflow, or add an optional cloud converter. A cloud converter means the app is no longer fully offline for .skp files.

## Roadmap

- [ ] DWG (once the decision above is made)
- [ ] HATCH fills, linetypes (dashed lines), line weights
- [ ] Calibrate scale for drawings with unknown units ("this line is 3.6 m")
- [ ] Export a marked-up PDF report (notes, measurements, photos)
- [ ] Attach camera photos to notes
- [ ] AR: place the 3D model at real scale on site (ARCore / ARKit)
- [ ] "Open with…" from the file manager, email and WhatsApp (Android intent filters, iOS document types)
- [ ] Measure along a polyline, angle measurement, layer presets
