# DJ1000 Converter Web

React + TypeScript + Vite app for browsing, culling, and editing Mitsubishi DJ-1000 / UMAX PhotoRun `.DAT` files.

This repo is intended to stay as the app shell around [`dj1000-converter-lib`](../dj1000-converter-lib), not a second copy of the converter algorithm.

## Goals

- keep one UI codebase for both Electron and static web deployment
- make the GitHub Pages build degrade gracefully when desktop-only capabilities are unavailable
- feel like Lightroom or Apple Photos reimagined as a Windows 98 application
- stay fast for batch culling, filmstrip navigation, and repeated edits

## Runtime Model

The renderer codebase is shared.

- Static web mode:
  - imports DAT files from browser file pickers
  - keeps DAT bytes in browser memory
  - exports files back through browser downloads
- Electron mode:
  - uses native file/folder dialogs
  - can work in place beside removable media or copied folders
  - can write `.DAT.json` settings sidecars next to the source DAT files
  - can export batches directly to disk

The feature split is handled through a thin preload bridge in [`electron`](electron), while the React app itself lives in [`src`](src).

## Converter Dependency

This app consumes the WebAssembly build from the sibling library repo:

- expected local sibling path: `../dj1000-converter-lib`
- synced files land in `public/vendor/dj1000`

Before running the app locally, build the library WASM target:

```bash
cd ../dj1000-converter-lib
emcmake cmake -S . -B build-wasm -G Ninja \
  -DDJ1000_BUILD_WASM=ON \
  -DDJ1000_BUILD_CLI=OFF \
  -DDJ1000_BUILD_TESTS=OFF
cmake --build build-wasm --target dj1000_wasm
```

Then inside this repo:

```bash
npm install
npm run sync:vendor
```

If your library repo lives somewhere else, set `DJ1000_LIB_DIR` before running the sync/build scripts.

## Scripts

- `npm run dev`  
  Static web development with Vite.
- `npm run dev:electron`  
  Shared renderer + Electron shell development.
- `npm run build:pages`  
  Builds the static GitHub Pages output.
- `npm run build`  
  Builds the renderer and the Electron main/preload bundle.
- `npm run dist:electron`  
  Builds the renderer/main bundle and packages the Electron app with `electron-builder`.
- `npm run lint`
- `npm run typecheck`

## Current App Shape

The scaffold already includes:

- library grid with large-pipeline thumbnails
- develop view with a large preview, right-hand controls, and bottom filmstrip
- worker-based WASM rendering so slider drags stay off the main thread
- per-photo session caching through `dj1000::Session` in the underlying library
- browser and Electron import/export paths
- sidecar parsing and automatic edit restoration from `.DAT.json`

## GitHub Pages

The repo is set up to deploy through GitHub Actions.

The Pages workflow:

1. checks out this app repo
2. checks out `oleyb/dj1000-converter-lib`
3. builds the library WASM target
4. syncs the generated WASM helper into `public/vendor/dj1000`
5. builds the Vite app
6. publishes `dist/` to GitHub Pages

See [App Architecture](docs/app-architecture.md) for the repo and runtime layout.
