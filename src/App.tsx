import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from "react";

import {
  buildBrowserExportArchive,
  buildBrowserExportBundle,
  buildDesktopExportPayload,
  triggerBrowserDownload,
} from "./lib/exporters";
import { createPhotoRecord, parseBrowserImport } from "./lib/importers";
import { Dj1000RenderPool } from "./lib/renderPool";
import { stringifySidecar } from "./lib/sidecar";
import { getDesktopBridge, isDesktopRuntime } from "./platform/desktop";
import type {
  ExportDialogState,
  ExportScope,
  ImportDialogState,
  ImportKind,
  PhotoEdits,
  PhotoRecord,
  RenderedFrame,
} from "./types/models";

const toneSliderLabels = [
  { id: "contrast", label: "Contrast" },
  { id: "brightness", label: "Brightness" },
  { id: "vividness", label: "Vividness" },
  { id: "sharpness", label: "Sharpness" },
] as const satisfies ReadonlyArray<{ id: keyof PhotoEdits; label: string }>;

const colorBalanceLabels = [
  { id: "redBalance", label: "Red" },
  { id: "greenBalance", label: "Green" },
  { id: "blueBalance", label: "Blue" },
] as const satisfies ReadonlyArray<{ id: keyof PhotoEdits; label: string }>;

function formatCount(label: string, value: number) {
  return `${value} ${label}${value === 1 ? "" : "s"}`;
}

function buildBrowserArchiveName(scope: ExportScope, photos: PhotoRecord[]) {
  if (scope === "current" && photos.length === 1) {
    return `${photos[0].name.replace(/\.dat$/i, "")}.zip`;
  }
  if (scope === "selected") {
    return "selected-photos.zip";
  }
  return "all-photos.zip";
}

function buildPreviewSignature(photoId: string, edits: PhotoEdits) {
  return [
    photoId,
    edits.size,
    edits.redBalance,
    edits.greenBalance,
    edits.blueBalance,
    edits.contrast,
    edits.brightness,
    edits.vividness,
    edits.sharpness,
  ].join(":");
}

function PhotoCanvas({ frame }: { frame?: RenderedFrame }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) {
      return;
    }

    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const imageData = new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height);
    context.putImageData(imageData, 0, 0);
  }, [frame]);

  return <canvas ref={canvasRef} width={frame?.width ?? 504} height={frame?.height ?? 378} />;
}

function SliderRow({
  label,
  value,
  min,
  max,
  onChange,
  tone = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  tone?: boolean;
}) {
  return (
    <label className="slider-stack">
      <span className="slider-caption">
        <span>{label}</span>
        <span>{tone && value > 0 ? `+${value}` : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onInput={(event) => onChange(Number((event.target as HTMLInputElement).value))}
      />
      <span className="slider-scale">
        <span>{tone ? min : "Weak"}</span>
        <span>{tone ? 0 : "Neutral"}</span>
        <span>{tone ? `+${max}` : "Strong"}</span>
      </span>
    </label>
  );
}

function AppMenu({
  photosLoaded,
  isDevelopMode,
  openMenu,
  onOpenMenu,
  onCloseMenu,
  onImportFiles,
  onImportFolder,
  onExportCurrent,
  onExportSelected,
  onExportAll,
  onSelectAll,
  onClearSelection,
  onResetCurrent,
  onShowLibrary,
  onShowDevelop,
}: {
  photosLoaded: boolean;
  isDevelopMode: boolean;
  openMenu: string | null;
  onOpenMenu: (menu: string | null) => void;
  onCloseMenu: () => void;
  onImportFiles: () => void;
  onImportFolder: () => void;
  onExportCurrent: () => void;
  onExportSelected: () => void;
  onExportAll: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onResetCurrent: () => void;
  onShowLibrary: () => void;
  onShowDevelop: () => void;
}) {
  return (
    <div className="menu-strip" onMouseLeave={onCloseMenu}>
      <button className="menu-button" onClick={() => onOpenMenu(openMenu === "file" ? null : "file")}>
        File
      </button>
      <button className="menu-button" onClick={() => onOpenMenu(openMenu === "edit" ? null : "edit")}>
        Edit
      </button>
      <button className="menu-button" onClick={() => onOpenMenu(openMenu === "view" ? null : "view")}>
        View
      </button>

      {openMenu === "file" && (
        <div className="window menu-dropdown">
          <div className="window-body field-column">
            <button onClick={onImportFiles}>Open Files…</button>
            <button onClick={onImportFolder}>Open Folder…</button>
            <button disabled={!photosLoaded || !isDevelopMode} onClick={onExportCurrent}>
              Export Current
            </button>
            <button disabled={!photosLoaded} onClick={onExportSelected}>
              Export Selected
            </button>
            <button disabled={!photosLoaded} onClick={onExportAll}>
              Export All
            </button>
          </div>
        </div>
      )}

      {openMenu === "edit" && (
        <div className="window menu-dropdown">
          <div className="window-body field-column">
            <button disabled={!photosLoaded} onClick={onSelectAll}>
              Select All
            </button>
            <button disabled={!photosLoaded} onClick={onClearSelection}>
              Clear Selection
            </button>
            <button disabled={!isDevelopMode} onClick={onResetCurrent}>
              Reset Current Photo
            </button>
          </div>
        </div>
      )}

      {openMenu === "view" && (
        <div className="window menu-dropdown">
          <div className="window-body field-column">
            <button onClick={onShowLibrary}>Library</button>
            <button disabled={!photosLoaded} onClick={onShowDevelop}>
              Develop
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ImportDialog({
  state,
  onClose,
  onChangeKind,
  onChangeIngest,
  onRun,
}: {
  state: ImportDialogState;
  onClose: () => void;
  onChangeKind: (kind: ImportKind) => void;
  onChangeIngest: (ingestMode: ImportDialogState["ingestMode"]) => void;
  onRun: () => void;
}) {
  if (!state.isOpen) {
    return null;
  }

  return (
    <div className="dialog-backdrop">
      <div className="window dialog-window">
        <div className="title-bar">
          <div className="title-bar-text">Import DJ1000 Photos</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="window-body field-column">
          <div className="field-row-stacked">
            <label htmlFor="import-kind">Source</label>
            <select id="import-kind" value={state.kind} onChange={(event) => onChangeKind(event.target.value as ImportKind)}>
              <option value="files">Open one or more DAT files</option>
              <option value="folder">Open a folder of DAT files</option>
            </select>
          </div>

          <div className="field-row-stacked">
            <label htmlFor="ingest-mode">How to work with the files</label>
            <select
              id="ingest-mode"
              value={state.ingestMode}
              onChange={(event) => onChangeIngest(event.target.value as ImportDialogState["ingestMode"])}
            >
              <option value="in-place">Work with files where they already are</option>
              <option value="copy">Copy imported DAT files to a new folder</option>
            </select>
          </div>

          <p className="field-help">
            Desktop app mode can work directly from removable media or copy the files into a new folder.
          </p>

          <div className="dialog-actions">
            <button onClick={onRun}>Continue</button>
            <button onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExportDialog({
  state,
  desktopAvailable,
  currentDisabled,
  selectedDisabled,
  allDisabled,
  onClose,
  onChange,
  onRun,
}: {
  state: ExportDialogState;
  desktopAvailable: boolean;
  currentDisabled: boolean;
  selectedDisabled: boolean;
  allDisabled: boolean;
  onClose: () => void;
  onChange: (next: ExportDialogState) => void;
  onRun: () => void;
}) {
  if (!state.isOpen) {
    return null;
  }

  return (
    <div className="dialog-backdrop">
      <div className="window dialog-window">
        <div className="title-bar">
          <div className="title-bar-text">Export Photos</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="window-body field-column">
          <div className="field-row-stacked">
            <label htmlFor="export-scope">What to export</label>
            <select
              id="export-scope"
              value={state.scope}
              onChange={(event) => onChange({ ...state, scope: event.target.value as ExportScope })}
            >
              <option value="current" disabled={currentDisabled}>
                Export Current
              </option>
              <option value="selected" disabled={selectedDisabled}>
                Export Selected
              </option>
              <option value="all" disabled={allDisabled}>
                Export All
              </option>
            </select>
          </div>

          <div className="field-row-stacked">
            <label htmlFor="export-format">Format</label>
            <select
              id="export-format"
              value={state.format}
              onChange={(event) => onChange({ ...state, format: event.target.value as ExportDialogState["format"] })}
            >
              <option value="png">PNG (lossless)</option>
              <option value="jpeg">JPEG (compressed)</option>
            </select>
          </div>

          <label className="field-row">
            <input
              type="checkbox"
              checked={state.includeSourceBundle}
              onChange={(event) => onChange({ ...state, includeSourceBundle: event.target.checked })}
            />
            <span>Also include the original DAT file with the settings file</span>
          </label>

          {!desktopAvailable ? (
            <p className="field-help">
              Website exports download as a single ZIP file so everything stays together.
            </p>
          ) : null}

          <div className="dialog-actions">
            <button onClick={onRun}>Export</button>
            <button onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const desktopBridge = getDesktopBridge();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const renderPoolRef = useRef<Dj1000RenderPool | null>(null);
  const photosRef = useRef<PhotoRecord[]>([]);
  const saveTimersRef = useRef(new Map<string, number>());
  const thumbnailTimersRef = useRef(new Map<string, number>());
  const desiredPreviewRef = useRef<{ photoId: string; edits: PhotoEdits; name: string; signature: string } | null>(null);
  const activePreviewSignatureRef = useRef<string | null>(null);

  const [photos, setPhotos] = useState<PhotoRecord[]>([]);
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [view, setView] = useState<"library" | "develop">("library");
  const [status, setStatus] = useState("Open DJ-1000 photos to browse, adjust, and export them.");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [importDialog, setImportDialog] = useState<ImportDialogState>({
    isOpen: false,
    kind: "files",
    ingestMode: "in-place",
  });
  const [exportDialog, setExportDialog] = useState<ExportDialogState>({
    isOpen: false,
    scope: "current",
    format: "png",
    includeSourceBundle: false,
  });

  const activePhoto = useMemo(
    () => photos.find((photo) => photo.id === activePhotoId) ?? null,
    [photos, activePhotoId],
  );
  const activePhotoName = activePhoto?.name ?? "";
  const activeEditSize = activePhoto?.edits.size ?? null;
  const activeRedBalance = activePhoto?.edits.redBalance ?? null;
  const activeGreenBalance = activePhoto?.edits.greenBalance ?? null;
  const activeBlueBalance = activePhoto?.edits.blueBalance ?? null;
  const activeContrast = activePhoto?.edits.contrast ?? null;
  const activeBrightness = activePhoto?.edits.brightness ?? null;
  const activeVividness = activePhoto?.edits.vividness ?? null;
  const activeSharpness = activePhoto?.edits.sharpness ?? null;
  const selectedPhotos = useMemo(
    () => photos.filter((photo) => selectedIds.has(photo.id)),
    [photos, selectedIds],
  );
  const libraryStats = useMemo(
    () => ({
      total: photos.length,
      selected: selectedIds.size,
      ready: photos.filter((photo) => photo.thumbnailStatus === "ready").length,
    }),
    [photos, selectedIds],
  );

  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  useEffect(() => {
    const pool = new Dj1000RenderPool();
    renderPoolRef.current = pool;
    const activeSaveTimers = saveTimersRef.current;
    const activeThumbnailTimers = thumbnailTimersRef.current;

    return () => {
      for (const timer of activeSaveTimers.values()) {
        window.clearTimeout(timer);
      }
      activeSaveTimers.clear();
      for (const timer of activeThumbnailTimers.values()) {
        window.clearTimeout(timer);
      }
      activeThumbnailTimers.clear();
      pool.dispose();
      for (const photo of photosRef.current) {
        if (photo.thumbnailUrl) {
          // No-op for data URLs, but future blob URLs can be cleaned here.
        }
      }
    };
  }, []);

  const replacePhoto = useCallback((photoId: string, updater: (photo: PhotoRecord) => PhotoRecord) => {
    setPhotos((current) => current.map((photo) => (photo.id === photoId ? updater(photo) : photo)));
  }, []);

  async function frameToThumbnailUrl(frame: RenderedFrame) {
    const canvas = document.createElement("canvas");
    const maxWidth = 240;
    const aspectRatio = frame.height / frame.width;
    canvas.width = maxWidth;
    canvas.height = Math.max(1, Math.round(maxWidth * aspectRatio));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to create a canvas for thumbnail generation.");
    }

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = frame.width;
    tempCanvas.height = frame.height;
    const tempContext = tempCanvas.getContext("2d");
    if (!tempContext) {
      throw new Error("Unable to create a temporary canvas.");
    }
    tempContext.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0);
    context.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  }

  async function queueThumbnailRender(photoId: string) {
    const photo = photosRef.current.find((entry) => entry.id === photoId);
    if (!photo) {
      return;
    }

    replacePhoto(photoId, (entry) => ({ ...entry, thumbnailStatus: "loading", error: undefined }));
    try {
      const frame = await renderPoolRef.current!.render(
        photoId,
        { ...photo.edits, size: "large" },
        "thumbnail",
      );
      const thumbnailUrl = await frameToThumbnailUrl(frame);
      replacePhoto(photoId, (entry) => ({
        ...entry,
        thumbnail: frame,
        thumbnailUrl,
        thumbnailStatus: "ready",
      }));
    } catch (error) {
      replacePhoto(photoId, (entry) => ({
        ...entry,
        thumbnailStatus: "error",
        error: String(error instanceof Error ? error.message : error),
      }));
    }
  }

  function scheduleThumbnailRender(photoId: string, delayMs = 180) {
    const existing = thumbnailTimersRef.current.get(photoId);
    if (existing) {
      window.clearTimeout(existing);
    }

    const timer = window.setTimeout(() => {
      thumbnailTimersRef.current.delete(photoId);
      void queueThumbnailRender(photoId);
    }, delayMs);
    thumbnailTimersRef.current.set(photoId, timer);
  }

  const requestLatestPreview = useCallback(() => {
    const pool = renderPoolRef.current;
    const desired = desiredPreviewRef.current;
    if (!pool || !desired || activePreviewSignatureRef.current !== null) {
      return;
    }

    activePreviewSignatureRef.current = desired.signature;
    void pool
      .render(desired.photoId, desired.edits, "preview")
      .then((frame) => {
        replacePhoto(desired.photoId, (photo) => ({
          ...photo,
          preview: frame,
          previewStatus: desiredPreviewRef.current?.signature === desired.signature ? "ready" : "loading",
        }));

        if (desiredPreviewRef.current?.signature === desired.signature) {
          setStatus(`Preview ready for ${desired.name}.`);
        }
      })
      .catch((error) => {
        if (desiredPreviewRef.current?.signature !== desired.signature) {
          return;
        }

        replacePhoto(desired.photoId, (photo) => ({
          ...photo,
          previewStatus: "error",
          error: String(error instanceof Error ? error.message : error),
        }));
        setStatus(`Preview failed for ${desired.name}.`);
      })
      .finally(() => {
        const finishedSignature = desired.signature;
        activePreviewSignatureRef.current = null;
        if (desiredPreviewRef.current?.signature !== finishedSignature) {
          void requestLatestPreview();
        }
      });
  }, [replacePhoto]);

  useEffect(() => {
    if (
      !activePhotoId ||
      activeEditSize === null ||
      activeRedBalance === null ||
      activeGreenBalance === null ||
      activeBlueBalance === null ||
      activeContrast === null ||
      activeBrightness === null ||
      activeVividness === null ||
      activeSharpness === null
    ) {
      desiredPreviewRef.current = null;
      return;
    }

    const edits: PhotoEdits = {
      size: activeEditSize,
      redBalance: activeRedBalance,
      greenBalance: activeGreenBalance,
      blueBalance: activeBlueBalance,
      contrast: activeContrast,
      brightness: activeBrightness,
      vividness: activeVividness,
      sharpness: activeSharpness,
    };
    const signature = buildPreviewSignature(activePhotoId, edits);
    desiredPreviewRef.current = {
      photoId: activePhotoId,
      edits,
      name: activePhotoName,
      signature,
    };

    setStatus(`Rendering ${activePhotoName} in the develop view...`);
    replacePhoto(activePhotoId, (photo) => ({ ...photo, previewStatus: "loading", error: undefined }));
    void requestLatestPreview();
  }, [
    activePhotoId,
    activePhotoName,
    activeEditSize,
    activeRedBalance,
    activeGreenBalance,
    activeBlueBalance,
    activeContrast,
    activeBrightness,
    activeVividness,
    activeSharpness,
    replacePhoto,
    requestLatestPreview,
  ]);

  async function hydrateImportedPhotos(payloads: ReturnType<typeof createPhotoRecord>[]) {
    const pool = renderPoolRef.current;
    if (!pool || payloads.length === 0) {
      return;
    }

    setStatus(`Opening ${formatCount("photo", payloads.length)}...`);
    for (const payload of payloads) {
      try {
        await pool.openDocument(payload.id, payload.datBytes);
        void queueThumbnailRender(payload.id);
      } catch (error) {
        replacePhoto(payload.id, (photo) => ({
          ...photo,
          thumbnailStatus: "error",
          previewStatus: "error",
          error: String(error instanceof Error ? error.message : error),
        }));
      }
    }
  }

  async function ingestPayloads(payloads: ReturnType<typeof createPhotoRecord>[]) {
    if (payloads.length === 0) {
      setStatus("No DAT files were found in that import selection.");
      return;
    }

    startTransition(() => {
      setPhotos((current) => [...current, ...payloads]);
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const photo of payloads) {
          next.add(photo.id);
        }
        return next;
      });
      if (!activePhotoId) {
        setActivePhotoId(payloads[0].id);
      }
    });

    await hydrateImportedPhotos(payloads);
    setStatus(`Imported ${formatCount("photo", payloads.length)}.`);
  }

  async function runDesktopImport() {
    if (!desktopBridge) {
      return;
    }

    setImportDialog((current) => ({ ...current, isOpen: false }));
    const result = await desktopBridge.pickImport({
      kind: importDialog.kind,
      ingestMode: importDialog.ingestMode,
    });
    const payloads = result.entries.map((entry) =>
      createPhotoRecord({
        name: entry.name,
        relativePath: entry.relativePath,
        filePath: entry.filePath,
        sidecarPath: entry.sidecarPath,
        ingestMode: entry.ingestMode,
        bytes: new Uint8Array(entry.bytes),
        sidecarText: entry.sidecarText,
      }),
    );
    await ingestPayloads(payloads);
  }

  async function handleBrowserFileInput(_kind: ImportKind, event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }

    const payloads = (await parseBrowserImport(files, "in-place")).map(createPhotoRecord);
    event.target.value = "";
    await ingestPayloads(payloads);
  }

  function openImport(kind: ImportKind) {
    setOpenMenu(null);
    if (!desktopBridge) {
      launchBrowserImport(kind);
      return;
    }
    setImportDialog((current) => ({ ...current, isOpen: true, kind }));
  }

  function launchBrowserImport(kind: ImportKind) {
    if (kind === "folder") {
      folderInputRef.current?.click();
      return;
    }
    fileInputRef.current?.click();
  }

  function handleImportRun() {
    if (desktopBridge) {
      void runDesktopImport();
      return;
    }
    const kind = importDialog.kind;
    setImportDialog((current) => ({ ...current, isOpen: false }));
    launchBrowserImport(kind);
  }

  function updatePhotoEdits(photoId: string, patch: Partial<PhotoEdits>) {
    const photo = photosRef.current.find((entry) => entry.id === photoId);
    if (!photo) {
      return;
    }

    const nextPhoto = {
      ...photo,
      edits: {
        ...photo.edits,
        ...patch,
      },
    };
    replacePhoto(photoId, () => nextPhoto);
    scheduleThumbnailRender(photoId);

    if (desktopBridge && nextPhoto.ingestMode === "in-place" && nextPhoto.filePath) {
      const existing = saveTimersRef.current.get(photoId);
      if (existing) {
        window.clearTimeout(existing);
      }
      const timer = window.setTimeout(() => {
        void desktopBridge.persistSidecar({
          filePath: nextPhoto.filePath!,
          sidecarText: stringifySidecar(nextPhoto.edits),
        });
      }, 240);
      saveTimersRef.current.set(photoId, timer);
    }
  }

  function resetCurrentPhoto() {
    if (!activePhoto) {
      return;
    }
    updatePhotoEdits(activePhoto.id, {
      size: "large",
      redBalance: 100,
      greenBalance: 100,
      blueBalance: 100,
      contrast: 0,
      brightness: 0,
      vividness: 0,
      sharpness: 0,
    });
  }

  function handleSelectPhoto(photoId: string, event?: MouseEvent<HTMLButtonElement>) {
    setActivePhotoId(photoId);

    if (event?.metaKey || event?.ctrlKey) {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(photoId)) {
          next.delete(photoId);
        } else {
          next.add(photoId);
        }
        return next;
      });
      return;
    }

    setSelectedIds(new Set([photoId]));
  }

  function collectExportTargets(scope: ExportScope) {
    if (scope === "current") {
      return activePhoto ? [activePhoto] : [];
    }
    if (scope === "selected") {
      return selectedPhotos;
    }
    return photos;
  }

  async function runExport() {
    const targets = collectExportTargets(exportDialog.scope);
    if (targets.length === 0) {
      setStatus("No photos are available for that export.");
      setExportDialog((current) => ({ ...current, isOpen: false }));
      return;
    }

    const browserFiles = [];
    const desktopFiles = [];
    setStatus(`Preparing ${formatCount("photo", targets.length)} for export...`);

    for (const photo of targets) {
      const frame = await renderPoolRef.current!.render(photo.id, photo.edits, "export");
      if (desktopBridge) {
        const files = await buildDesktopExportPayload(
          photo,
          frame,
          exportDialog.format,
          exportDialog.includeSourceBundle,
        );
        desktopFiles.push(...files);
      } else {
        const files = await buildBrowserExportBundle(
          photo,
          frame,
          exportDialog.format,
          exportDialog.includeSourceBundle,
        );
        browserFiles.push(...files);
      }
    }

    if (desktopBridge) {
      await desktopBridge.exportFiles({
        files: desktopFiles,
        suggestedFolderName: "dj1000-export",
      });
    } else {
      const archive = await buildBrowserExportArchive(browserFiles);
      triggerBrowserDownload(archive, buildBrowserArchiveName(exportDialog.scope, targets));
    }

    setExportDialog((current) => ({ ...current, isOpen: false }));
    setStatus(`Exported ${formatCount("photo", targets.length)}.`);
  }

  const platformLabel = isDesktopRuntime() ? "Desktop App" : "Website";

  return (
    <div className="app-shell">
      <input
        ref={fileInputRef}
        type="file"
        hidden
        multiple
        accept=".dat,.DAT,.json"
        onChange={(event) => void handleBrowserFileInput("files", event)}
      />
      <input
        ref={folderInputRef}
        type="file"
        hidden
        multiple
        webkitdirectory=""
        accept=".dat,.DAT,.json"
        onChange={(event) => void handleBrowserFileInput("folder", event)}
      />

      <ImportDialog
        state={importDialog}
        onClose={() => setImportDialog((current) => ({ ...current, isOpen: false }))}
        onChangeKind={(kind) => setImportDialog((current) => ({ ...current, kind }))}
        onChangeIngest={(ingestMode) => setImportDialog((current) => ({ ...current, ingestMode }))}
        onRun={handleImportRun}
      />

      <ExportDialog
        state={exportDialog}
        desktopAvailable={!!desktopBridge}
        currentDisabled={!activePhoto}
        selectedDisabled={selectedPhotos.length === 0}
        allDisabled={photos.length === 0}
        onClose={() => setExportDialog((current) => ({ ...current, isOpen: false }))}
        onChange={setExportDialog}
        onRun={() => void runExport()}
      />

      <div className="desktop-frame">
        <div className="window">
          <div className="title-bar">
            <div className="title-bar-text">Mitsubishi DJ-1000 / UMAX PhotoRun Editor</div>
            <div className="title-bar-controls">
              <button aria-label="Minimize" />
              <button aria-label="Maximize" />
              <button aria-label="Close" />
            </div>
          </div>
          <div className="window-body shell-toolbar">
            <AppMenu
              photosLoaded={photos.length > 0}
              isDevelopMode={view === "develop"}
              openMenu={openMenu}
              onOpenMenu={setOpenMenu}
              onCloseMenu={() => setOpenMenu(null)}
              onImportFiles={() => openImport("files")}
              onImportFolder={() => openImport("folder")}
              onExportCurrent={() => setExportDialog((current) => ({ ...current, isOpen: true, scope: "current" }))}
              onExportSelected={() => setExportDialog((current) => ({ ...current, isOpen: true, scope: "selected" }))}
              onExportAll={() => setExportDialog((current) => ({ ...current, isOpen: true, scope: "all" }))}
              onSelectAll={() => setSelectedIds(new Set(photos.map((photo) => photo.id)))}
              onClearSelection={() => setSelectedIds(new Set())}
              onResetCurrent={resetCurrentPhoto}
              onShowLibrary={() => setView("library")}
              onShowDevelop={() => setView("develop")}
            />

            <button onClick={() => openImport("files")}>Import</button>
            <button disabled={!activePhoto} onClick={() => setView("develop")}>
              Develop
            </button>
            <button disabled={photos.length === 0} onClick={() => setView("library")}>
              Library
            </button>
            <div className="shell-toolbar-spacer" />
            <span className="shell-badge">{formatCount("photo", libraryStats.total)}</span>
            <span className="shell-badge">{formatCount("selected item", libraryStats.selected)}</span>
            <span className="shell-badge platform-pill">{platformLabel}</span>
          </div>
        </div>

        <div className="workspace-grid">
          <section className="window window-fill">
            <div className="title-bar">
              <div className="title-bar-text">Project Navigator</div>
              <div className="title-bar-controls">
                <button aria-label="Help" />
              </div>
            </div>
            <div className="window-body window-body-fill">
              <div className="field-column">
                <button onClick={() => openImport("files")}>Open DAT Files…</button>
                <button onClick={() => openImport("folder")}>Open Folder…</button>
                {!desktopBridge ? (
                  <p className="field-help compact-help">Your photos stay on this device. Nothing is uploaded.</p>
                ) : null}
              </div>

              <div className="sunken-panel" style={{ padding: 10 }}>
                <div className="field-column">
                  <strong>Current workspace</strong>
                  <span>
                    {desktopBridge
                      ? "Work directly from your files and save settings beside them as you go."
                      : "Your photos stay on this device while you browse, adjust, and export them."}
                  </span>
                </div>
              </div>

              <div className="status-bar">
                <p className="status-bar-field">{formatCount("photo", libraryStats.total)}</p>
                <p className="status-bar-field">{formatCount("selected", libraryStats.selected)}</p>
                <p className="status-bar-field">{formatCount("ready preview", libraryStats.ready)}</p>
              </div>

              {activePhoto ? (
                <div className="window window-fill">
                  <div className="title-bar">
                    <div className="title-bar-text">Selection Inspector</div>
                    <div className="title-bar-controls">
                      <button aria-label="Close" />
                    </div>
                  </div>
                  <div className="window-body sidebar-scroll field-column">
                    <strong>{activePhoto.name}</strong>
                    <span className="surface-muted">{activePhoto.relativePath}</span>
                    <span>Status: {activePhoto.previewStatus}</span>
                    <span>Working size: {activePhoto.edits.size}</span>
                    <span>
                      Tone: {activePhoto.edits.contrast}/{activePhoto.edits.brightness}/{activePhoto.edits.vividness}/{activePhoto.edits.sharpness}
                    </span>
                    <span>
                      Color: {activePhoto.edits.redBalance}/{activePhoto.edits.greenBalance}/{activePhoto.edits.blueBalance}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="placeholder-copy sunken-panel">
                  <strong>No photo selected yet</strong>
                  <span>Select a thumbnail in the library to jump into the develop view.</span>
                </div>
              )}
            </div>
          </section>

          <section className="window window-fill">
            <div className="title-bar">
              <div className="title-bar-text">
                {view === "library" ? "Library Grid" : `Develop Module${activePhoto ? ` — ${activePhoto.name}` : ""}`}
              </div>
              <div className="title-bar-controls">
                <button aria-label="Minimize" />
                <button aria-label="Restore" />
                <button aria-label="Close" />
              </div>
            </div>
            <div className="window-body window-body-fill">
              {photos.length === 0 ? (
                <div className="placeholder-copy sunken-panel">
                  <strong>Start with your camera photos</strong>
                  <span>
                    Open a folder, memory card, or a few DAT files. You can browse everything in the library,
                    then open one photo at a time with the rest waiting in the film strip below.
                  </span>
                  <div className="empty-state-actions">
                    <button onClick={() => openImport("files")}>Open Files…</button>
                    <button onClick={() => openImport("folder")}>Open Folder…</button>
                  </div>
                  {!desktopBridge ? <p className="field-help compact-help">Your photos stay on this device. Nothing is uploaded.</p> : null}
                </div>
              ) : view === "library" ? (
                <div className="window-body-fill">
                  <div className="button-row">
                    <button onClick={() => setView("develop")} disabled={!activePhoto}>
                      Open In Develop
                    </button>
                    <button onClick={() => setExportDialog((current) => ({ ...current, isOpen: true, scope: "selected" }))}>
                      Export Selected
                    </button>
                  </div>
                  <div className="library-scroll sunken-panel" style={{ padding: 10 }}>
                    <div className="library-grid">
                      {photos.map((photo) => (
                        <button
                          key={photo.id}
                          className={`thumbnail-card ${selectedIds.has(photo.id) ? "is-selected" : ""} ${
                            activePhotoId === photo.id ? "is-active" : ""
                          }`}
                          onClick={(event) => handleSelectPhoto(photo.id, event)}
                          onDoubleClick={() => {
                            setView("develop");
                            setActivePhotoId(photo.id);
                            setSelectedIds(new Set([photo.id]));
                          }}
                        >
                          <div className="thumbnail-figure">
                            {photo.thumbnailUrl ? <img src={photo.thumbnailUrl} alt={photo.name} /> : <span>{photo.thumbnailStatus}</span>}
                          </div>
                          <div className="thumbnail-meta">
                            <span className="thumbnail-name">{photo.name}</span>
                            <span className="thumbnail-path">{photo.relativePath}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="window-body-fill">
                  <div className="develop-layout">
                    <div className="preview-panel">
                      <div className="sunken-panel preview-stage">
                        {activePhoto ? <PhotoCanvas frame={activePhoto.preview} /> : <span>No active photo</span>}
                      </div>
                      <div className="status-bar">
                        <p className="status-bar-field">{activePhoto?.name ?? "No file"}</p>
                        <p className="status-bar-field">
                          {activePhoto?.preview ? `${activePhoto.preview.width} × ${activePhoto.preview.height}` : "Preview pending"}
                        </p>
                        <p className="status-bar-field">{activePhoto?.previewStatus ?? "idle"}</p>
                      </div>
                    </div>

                    <div className="window window-fill">
                      <div className="title-bar">
                        <div className="title-bar-text">Develop Controls</div>
                        <div className="title-bar-controls">
                          <button aria-label="Close" />
                        </div>
                      </div>
                      <div className="window-body sidebar-scroll inspector-stack">
                        {activePhoto ? (
                          <>
                            <div className="field-row-stacked">
                              <label htmlFor="working-size">Working size</label>
                              <select
                                id="working-size"
                                value={activePhoto.edits.size}
                                onChange={(event) =>
                                  updatePhotoEdits(activePhoto.id, {
                                    size: event.target.value as PhotoEdits["size"],
                                  })
                                }
                              >
                                <option value="small">Small</option>
                                <option value="normal">Normal</option>
                                <option value="large">Large</option>
                              </select>
                            </div>

                            <div className="window">
                              <div className="title-bar">
                                <div className="title-bar-text">Tone</div>
                                <div className="title-bar-controls">
                                  <button aria-label="Collapse" />
                                </div>
                              </div>
                              <div className="window-body field-column">
                                {toneSliderLabels.map((slider) => (
                                  <SliderRow
                                    key={slider.id}
                                    label={slider.label}
                                    value={activePhoto.edits[slider.id] as number}
                                    min={-3}
                                    max={3}
                                    tone
                                    onChange={(value) => updatePhotoEdits(activePhoto.id, { [slider.id]: value } as Partial<PhotoEdits>)}
                                  />
                                ))}
                              </div>
                            </div>

                            <div className="window">
                              <div className="title-bar">
                                <div className="title-bar-text">Color Balance</div>
                                <div className="title-bar-controls">
                                  <button aria-label="Collapse" />
                                </div>
                              </div>
                              <div className="window-body field-column">
                                {colorBalanceLabels.map((slider) => (
                                  <SliderRow
                                    key={slider.id}
                                    label={slider.label}
                                    value={activePhoto.edits[slider.id] as number}
                                    min={0}
                                    max={200}
                                    onChange={(value) => updatePhotoEdits(activePhoto.id, { [slider.id]: value } as Partial<PhotoEdits>)}
                                  />
                                ))}
                              </div>
                            </div>

                            <div className="button-row">
                              <button onClick={resetCurrentPhoto}>Reset Photo</button>
                              <button onClick={() => setExportDialog((current) => ({ ...current, isOpen: true, scope: "current" }))}>
                                Export Current
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="placeholder-copy">Choose a photo to edit.</div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="window window-fill">
                    <div className="title-bar">
                      <div className="title-bar-text">Film Strip</div>
                      <div className="title-bar-controls">
                        <button aria-label="Close" />
                      </div>
                    </div>
                    <div className="window-body filmstrip-scroll">
                      <div className="filmstrip">
                        {photos.map((photo) => (
                          <button
                            key={photo.id}
                            className={`filmstrip-button ${photo.id === activePhotoId ? "is-active" : ""}`}
                            onClick={() => {
                              setActivePhotoId(photo.id);
                              setSelectedIds(new Set([photo.id]));
                            }}
                          >
                            <div className="filmstrip-thumb">
                              {photo.thumbnailUrl ? <img src={photo.thumbnailUrl} alt={photo.name} /> : <span>{photo.thumbnailStatus}</span>}
                            </div>
                            <span className="filmstrip-label">{photo.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="status-bar status-row">
          <p className="status-bar-field">{status}</p>
          <p className="status-bar-field">{view === "library" ? "Library" : "Develop"}</p>
          <p className="status-bar-field">{platformLabel}</p>
        </div>
      </div>
    </div>
  );
}
