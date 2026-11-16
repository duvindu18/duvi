# CADView

Offline viewer for CAD drawings and 3D models on Android and iOS. Built with TypeScript and three.js, packaged with Capacitor. Files are processed on the device and never uploaded. Version 1.0 has no ads and doesn't use the internet (no INTERNET permission on Android).

## Supported files

| Format | Notes |
|---|---|
| DXF (ASCII) | Lines, polylines with arcs and widths, 3D polylines and meshes, circles, arcs, ellipses, splines, solids, 3D faces, hatches (patterns and solid fills, with islands), leaders and multileaders with arrows, text/MTEXT/attributes with text styles and wrapping, blocks (nested, rotated, scaled, arrays) and dimensions. Layers, line types and LTSCALE, ACI and true colour, ByLayer/ByBlock, OCS/extrusion, code pages. Paper space is skipped. Unsupported entities are listed in File info. |
| DWG (R12 to 2018+) | Converted to DXF on the device with [acad-ts](https://github.com/node-projects/acad-ts) (MIT), then shown like a DXF. The converted file is cached and can be shared from File info. |
| SKP (SketchUp 2013+) | Read with [openskp](https://github.com/iamahsanmehmood/openskp) (MIT). Components are kept instanced, so large models with many repeated components stay light. If a file can't be read, the preview image stored in it is shown. |
| GLB/glTF, OBJ, STL, PLY, DAE, 3MF | glTF Draco, meshopt and KTX2 decoders are bundled. |
| Binary DXF | Not supported yet. |

## Features

- Pan, pinch-zoom, rotate (lockable), double-tap / two-finger-tap zoom, fling.
- Distance and area measuring with snapping to corners, ends, midpoints and centres. Hold a placed point to move it.
- Notes pinned to the drawing; hold a pin to move it. Notes can be shared as text.
- Revision compare for DXF/DWG (added / removed / unchanged).
- Text search, layer and tag visibility, section cuts and standard views in 3D.
- Library of opened files with thumbnails; last view, notes and measurements are restored.
- Dark, light and high-contrast site mode.
- "Open with" from other apps on Android and iOS.

Removing a file from the list only deletes the app's own copy. The original file is never modified.

## Ads

Version 1.0 has no ads. The AdMob code is kept in `src/ads.ts` with `AD_CONFIG.enabled = false`, and the plugin isn't installed. The comments in that file list the steps to turn ads on again: the plugin, IDs, INTERNET permission, consent, and new privacy answers.

## Export and monochrome

- **Export** (Share button in the viewer): PDF on A4 to A1, or PNG. It covers the whole drawing, the visible area, or an area selected with two taps. The drawing is rendered off-screen in tiles at about 200 dpi, in colour or monochrome on white, with notes and measurements optional. The PDF footer gives the approximate scale.
- **Monochrome view** (More → Monochrome): all lines and text in one ink colour, and fills screened, for busy drawings. In 3D, models use a plain clay material.

## Publishing

See [`store/PUBLISHING.md`](store/PUBLISHING.md) for the Google Play and App Store steps (accounts, signing, builds, TestFlight, iPad). See [`store/FORMS.md`](store/FORMS.md) for the questionnaire answers. Listing texts, privacy policy, icons and screenshots are in `store/`.

## Large files

DXF and DWG are parsed in a Web Worker straight into typed arrays and split into spatial tiles. Segments and text too small to see are skipped when zoomed out. Snapping uses a grid index and 3D picking uses a BVH. SketchUp components are drawn with GPU instancing; distant ones are drawn as boxes.

Measured in headless Chromium on a laptop (`e2e/bigfiles.cjs`):

| File | Open time | Longest UI pause |
|---|---|---|
| DXF, 53 MB, 806k entities | 2.8 s | 34 ms |
| DWG, 0.9 MB, 40k entities | 2.4 s | 20 ms |
| STL, 196 MB, 3.9M triangles | 4.1 s | 179 ms |
| SKP, 5.7 MB, 3,000 components (10.8M triangles as placed) | 1.6 s | 19 ms |

## Development

```bash
npm install
npm run dev            # dev server, open on a phone on the same network
npm test               # unit tests
npm run build && npx vite preview --port 4173 &
node e2e/gestures.cjs http://localhost:4173/ /tmp   # touch gestures and tools
node e2e/screens.cjs  http://localhost:4173/ /tmp   # layouts on several screen sizes
node e2e/dwg.cjs      http://localhost:4173/ /tmp
node e2e/skp.cjs      http://localhost:4173/ /tmp
node e2e/export.cjs   http://localhost:4173/ /tmp   # PDF/PNG export, monochrome
```

Test files: `scripts/make-samples.ts`, `scripts/make-big.ts`, `scripts/make-dwg.ts`, `scripts/make-skp.ts`, `scripts/make-big-skp.ts`.

## Building the apps

```bash
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```

Use `npm run cap:ios` on a Mac for Xcode. Launcher icons and splash screens are generated with `node scripts/make-icons.cjs`.

Release builds: `npm run release:android` (signed AAB, needs `android/keystore.properties` from `scripts/make-upload-key.sh`) and `npm run release:ios` (opens Xcode for Archive).

## Source layout

```
src/cad/dxf.ts         DXF reader
src/cad/hatch.ts       hatch patterns and fills
src/cad/dwg.ts         DWG → DXF conversion
src/cad/skp.ts         SketchUp reader → instanced geometry
src/cad/tiles.ts       tiles and level of detail for 2D
src/cad/diff.ts        revision compare
src/cad/snapgrid.ts    snap index
src/worker.ts          background parsing
src/export.ts          PDF / PNG export
src/render/            gestures, viewer, text, scene building
src/ui/                icons, panels, popover, haptics
src/main.ts            app
```

## Known limitations

- DWG: some objects from add-ons (proxy entities, Civil 3D objects) may not convert.
- SKP: the reader is reverse-engineered; some files may only show their preview image.
- Line weights are not drawn; all lines are one pixel wide.
- Text uses one built-in font. SHX and TrueType fonts are approximated by width.
- Very dense hatch patterns are drawn as a light tint.
- Paper-space layouts (sheets) are not drawn; model space is.
