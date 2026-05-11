# App Architecture

## Repo Boundary

This repo owns the application shell.

It should contain:

- React UI
- Electron bridge and shell
- browser/Electron file workflow code
- worker orchestration
- GitHub Pages deployment plumbing

It should not contain:

- a forked copy of the converter algorithm
- reverse-engineering notes that belong in `dj1000-converter-lib`
- proprietary Windows runtime files

## Shared Codebase Strategy

The renderer is shared across static web and Electron.

- `src/App.tsx`
  Main Lightroom-like shell.
- `src/lib/renderPool.ts`
  Browser-side worker pool that keeps photo sessions open.
- `src/workers/dj1000.worker.ts`
  Module worker that loads the WASM helper and owns photo sessions.
- `src/platform/desktop.ts`
  Tiny capability layer for Electron-only APIs.
- `electron/main.ts` and `electron/preload.ts`
  Native shell and secure bridge for desktop-only file access.

The goal is to keep platform branching shallow:

- renderer logic decides what it wants to do
- platform adapters decide how that action is fulfilled

## Performance Direction

The app is optimized around culling and repeated edits.

Current direction:

- open one WASM session per imported photo
- keep those sessions inside workers, not on the main thread
- render thumbnails through the large conversion pipeline so the library view resembles the develop view
- prioritize preview and export renders ahead of background thumbnail work
- keep edit settings in app state so switching between photos is immediate

## Import Model

### Static Web

- open files via `<input type="file" multiple>`
- open folders via `<input webkitdirectory>`
- parse matching `.DAT.json` sidecars if present
- store DAT bytes in memory for the session

### Electron

- use native dialogs
- default to easy removable-media access when possible
- support two ingest modes:
  - work in place
  - copy to a new working folder
- auto-save sidecars beside DAT files during edit changes when working in place

## Export Model

The renderer asks the worker pool for a fresh render, then:

- static web triggers downloads
- Electron writes files to disk through IPC

Sidecar export is part of the shared model:

- every export can include a human-facing settings file
- optionally include the original DAT as part of the exported bundle

## Deployment Model

### GitHub Pages

- static Vite build
- SPA fallback via `404.html`
- WASM artifacts copied into `public/vendor/dj1000`

### Electron

- same renderer build
- separate `electron-dist` output for main/preload
- optional packaging through `electron-builder`
