import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import {
  buildBrowserExportArchiveWithProgress,
  buildBrowserExportBundle,
  buildBrowserDngExportBundle,
  buildBrowserSourceBundle,
  buildIdentifiedExportStem,
  buildDesktopExportPayload,
  buildDesktopDngExportPayload,
  buildDesktopSourceBundle,
  triggerBrowserDownload,
} from "./lib/exporters";
import { createTransformedFrameCanvas, drawFrameToCanvas, getTransformedFrameSize } from "./lib/frameTransforms";
import { createPhotoRecord, parseBrowserImport } from "./lib/importers";
import { Dj1000RenderPool } from "./lib/renderPool";
import { stringifySidecar } from "./lib/sidecar";
import { getDesktopBridge, isDesktopRuntime } from "./platform/desktop";
import type {
  ExportDialogState,
  ExportScope,
  ImportDialogState,
  ImportKind,
  LibraryImportMode,
  PhotoEdits,
  PhotoMetadata,
  PhotoRecord,
  PhotoReviewStatus,
  RenderExportFormat,
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

const zoomPercentOptions = [25, 50, 75, 100, 125, 150, 200, 250, 300, 350, 400] as const;
const fitViewportSafetyMarginPx = 2;
const exampleDatFiles = ["MDSC0001.DAT", "MDSC0003.DAT", "MDSC0005.DAT", "MDSC0010.DAT"] as const;
const hasLoadedOwnPhotosStorageKey = "dj1000.hasLoadedOwnPhotos";
const exportIncludeSourceBundleStorageKey = "dj1000.includeSourceBundle";
const rawConverterIncludeSourceBundleStorageKey = "dj1000.rawConverterIncludeSourceBundle";
const examplePhotoPathPrefix = "Example .DAT Files/";

type ReviewFilter = "all" | "picked" | "rejected" | "not-rejected";

interface ContextMenuState {
  photoId: string;
  x: number;
  y: number;
}

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

function buildDngArchiveName(fileCount: number) {
  return fileCount === 1 ? "converted-dng.zip" : "converted-dng-files.zip";
}

function summarizeFailedFiles(names: string[], limit = 5) {
  if (names.length === 0) {
    return "";
  }
  if (names.length <= limit) {
    return names.join(", ");
  }
  return `${names.slice(0, limit).join(", ")}, and ${names.length - limit} more`;
}

function loadStoredBooleanPreference(storageKey: string, defaultValue = true) {
  if (typeof window === "undefined") {
    return defaultValue;
  }

  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored === null ? defaultValue : stored === "true";
  } catch {
    return defaultValue;
  }
}

function getBrowserOnlineState() {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function formatNeedsDngSupport(format: ExportDialogState["format"]) {
  return format === "dng" || format === "dng-png" || format === "dng-jpeg";
}

function getRenderedExportFormat(format: ExportDialogState["format"]): RenderExportFormat | null {
  switch (format) {
    case "png":
    case "jpeg":
      return format;
    case "dng-png":
      return "png";
    case "dng-jpeg":
      return "jpeg";
    case "dng":
    default:
      return null;
  }
}

function comparePhotoNames(left: PhotoRecord, right: PhotoRecord) {
  if (left.importedAt !== right.importedAt) {
    return left.importedAt - right.importedAt;
  }

  const byName = left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (byName !== 0) {
    return byName;
  }

  return left.relativePath.localeCompare(right.relativePath, undefined, {
    numeric: true,
    sensitivity: "base",
  });
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

function describePhotoMetadata(metadata: PhotoMetadata) {
  const parts: string[] = [];
  if (metadata.rating > 0) {
    parts.push(`Rating ${metadata.rating}/5`);
  }
  if (metadata.reviewStatus === "flagged") {
    parts.push("Flagged");
  }
  if (metadata.reviewStatus === "rejected") {
    parts.push("Rejected");
  }
  if (metadata.removed) {
    parts.push("Removed");
  }
  return parts.join(" · ");
}

function describeOrientation(edits: PhotoEdits) {
  const parts: string[] = [];
  if (edits.rotation !== 0) {
    parts.push(`${edits.rotation}°`);
  }
  if (edits.flipHorizontal) {
    parts.push("Flip H");
  }
  if (edits.flipVertical) {
    parts.push("Flip V");
  }
  return parts.length > 0 ? parts.join(" · ") : "Standard";
}

function getDownloadFileName(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
}

function matchesReviewFilter(photo: PhotoRecord, reviewFilter: ReviewFilter) {
  switch (reviewFilter) {
    case "picked":
      return photo.metadata.reviewStatus === "flagged";
    case "rejected":
      return photo.metadata.reviewStatus === "rejected";
    case "not-rejected":
      return photo.metadata.reviewStatus !== "rejected";
    case "all":
    default:
      return true;
  }
}

function PhotoCanvas({
  frame,
  edits,
  zoomPercent,
  onFitZoomChange,
}: {
  frame?: RenderedFrame;
  edits?: PhotoEdits;
  zoomPercent: number;
  onFitZoomChange: (zoomPercent: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [isCompactLayout, setIsCompactLayout] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 960px)").matches : false,
  );
  const outputSize = frame && edits ? getTransformedFrameSize(frame, edits) : { width: 504, height: 378 };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame || !edits) {
      return;
    }

    drawFrameToCanvas(canvas, frame, edits);
  }, [edits, frame]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 960px)");
    const updateLayoutMode = () => setIsCompactLayout(mediaQuery.matches);

    updateLayoutMode();
    mediaQuery.addEventListener("change", updateLayoutMode);
    return () => mediaQuery.removeEventListener("change", updateLayoutMode);
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !frame || !edits) {
      return;
    }

    const updateFitZoom = () => {
      const width = Math.max(1, viewport.clientWidth - fitViewportSafetyMarginPx);
      const height = Math.max(1, viewport.clientHeight - fitViewportSafetyMarginPx);
      const scale = isCompactLayout
        ? width / outputSize.width
        : Math.min(width / outputSize.width, height / outputSize.height);
      const nextZoom = Math.max(5, scale * 100);
      onFitZoomChange(nextZoom);
    };

    updateFitZoom();
    const observer = new ResizeObserver(updateFitZoom);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [edits, frame, isCompactLayout, onFitZoomChange, outputSize.height, outputSize.width]);

  const canvasStyle = {
    width: `${Math.max(1, Math.floor((outputSize.width * zoomPercent) / 100))}px`,
    height: `${Math.max(1, Math.floor((outputSize.height * zoomPercent) / 100))}px`,
  };

  return (
    <div ref={viewportRef} className="preview-viewport">
      <div className="preview-canvas-shell">
        <canvas
          ref={canvasRef}
          className="preview-canvas"
          width={outputSize.width}
          height={outputSize.height}
          style={canvasStyle}
        />
      </div>
    </div>
  );
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
      <span className={`slider-scale ${tone ? "is-tone-scale" : ""}`.trim()}>
        <span>{tone ? min : "Weak"}</span>
        <span>{tone ? 0 : "Neutral"}</span>
        <span>{tone ? `+${max}` : "Strong"}</span>
      </span>
    </label>
  );
}

function RatingStars({
  rating,
  onSetRating,
}: {
  rating: number;
  onSetRating: (rating: number) => void;
}) {
  return (
    <div className="star-rating-row" role="group" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((value) => {
        const filled = rating >= value;
        return (
          <button
            key={value}
            className={`star-button ${filled ? "is-filled" : ""}`}
            onClick={() => onSetRating(value)}
            aria-label={`${value} star${value === 1 ? "" : "s"}`}
            title={`${value} star${value === 1 ? "" : "s"}`}
          >
            {filled ? "★" : "☆"}
          </button>
        );
      })}
    </div>
  );
}

function IconActionButton({
  label,
  icon,
  iconNode,
  active = false,
  disabled = false,
  showLabel = true,
  largeIcon = false,
  iconClassName,
  onClick,
}: {
  label: string;
  icon: string;
  iconNode?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  showLabel?: boolean;
  largeIcon?: boolean;
  iconClassName?: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`icon-action-button ${active ? "is-active" : ""} ${showLabel ? "" : "is-icon-only"} ${
        largeIcon ? "is-large-icon" : ""
      }`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <span className="icon-action-visual" aria-hidden="true">
        {iconNode ?? (
          <span className={`icon-action-glyph ${iconClassName ?? ""}`.trim()}>
            {icon}
          </span>
        )}
      </span>
      {showLabel ? <span className="icon-action-label">{label}</span> : null}
    </button>
  );
}

function ReviewActionButton({
  label,
  kind,
  active = false,
  onClick,
}: {
  label: string;
  kind: "pick" | "reject";
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`review-action-button ${active ? "is-active" : ""}`}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <span className={`review-action-icon review-action-icon--${kind}`} aria-hidden="true" />
    </button>
  );
}

function PhotoReviewSummary({ metadata, className }: { metadata: PhotoMetadata; className: string }) {
  if (metadata.rating === 0 && metadata.reviewStatus === "none" && !metadata.removed) {
    return null;
  }

  return (
    <div className={className} style={{margin: "auto"}} aria-label={describePhotoMetadata(metadata) || undefined}>
      {metadata.rating > 0 ? (
        <span className="review-summary-stars" aria-hidden="true">
          {[1, 2, 3, 4, 5].map((value) => (
            <span key={value} className={`review-summary-star ${metadata.rating >= value ? "is-filled" : ""}`}>
              ★
            </span>
          ))}
        </span>
      ) : null}
      {metadata.reviewStatus === "flagged" ? <span className="review-summary-icon review-summary-icon--pick" aria-hidden="true" /> : null}
      {metadata.reviewStatus === "rejected" ? <span className="review-summary-icon review-summary-icon--reject" aria-hidden="true" /> : null}
      {metadata.removed ? <span className="review-summary-chip">Removed</span> : null}
    </div>
  );
}

function AppMenu({
  photosLoaded,
  isDevelopMode,
  canPasteEdits,
  dngSupported,
  openMenu,
  onOpenMenu,
  onCloseMenu,
  onLoadDatFiles,
  onConvertDatFilesToDng,
  onClearCurrentLibrary,
  onExportCurrent,
  onExportSelected,
  onExportAll,
  onGenerateRawCurrent,
  onGenerateRawSelected,
  onGenerateRawAll,
  showRemoved,
  onToggleShowRemoved,
  onSelectAll,
  onClearSelection,
  onResetCurrent,
  onCopyCurrentEdits,
  onPasteCurrentEdits,
  onRotateCurrentLeft,
  onRotateCurrentRight,
  onFlipCurrentHorizontal,
  onFlipCurrentVertical,
  onShowLibrary,
  onShowDevelop,
  minimumRating,
  onSetMinimumRating,
  reviewFilter,
  onSetReviewFilter,
}: {
  photosLoaded: boolean;
  isDevelopMode: boolean;
  canPasteEdits: boolean;
  dngSupported: boolean;
  openMenu: string | null;
  onOpenMenu: (menu: string | null) => void;
  onCloseMenu: () => void;
  onLoadDatFiles: () => void;
  onConvertDatFilesToDng: () => void;
  onClearCurrentLibrary: () => void;
  onExportCurrent: () => void;
  onExportSelected: () => void;
  onExportAll: () => void;
  onGenerateRawCurrent: () => void;
  onGenerateRawSelected: () => void;
  onGenerateRawAll: () => void;
  showRemoved: boolean;
  onToggleShowRemoved: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onResetCurrent: () => void;
  onCopyCurrentEdits: () => void;
  onPasteCurrentEdits: () => void;
  onRotateCurrentLeft: () => void;
  onRotateCurrentRight: () => void;
  onFlipCurrentHorizontal: () => void;
  onFlipCurrentVertical: () => void;
  onShowLibrary: () => void;
  onShowDevelop: () => void;
  minimumRating: number;
  onSetMinimumRating: (rating: number) => void;
  reviewFilter: ReviewFilter;
  onSetReviewFilter: (reviewFilter: ReviewFilter) => void;
}) {
  const runMenuAction = (action: () => void) => () => {
    onCloseMenu();
    action();
  };
  const withCheck = (active: boolean, label: string) => `${active ? "✓ " : ""}${label}`;

  return (
    <div className="menu-strip">
      <div className="menu-anchor">
        <button className="menu-button" onClick={() => onOpenMenu(openMenu === "file" ? null : "file")}>
          File
        </button>
        {openMenu === "file" && (
          <div className="window menu-dropdown">
            <div className="window-body context-menu-body">
              <button className="context-menu-item" onClick={runMenuAction(onLoadDatFiles)}>
                Import .DAT Files into Library
              </button>
              {dngSupported ? (
                <>
                  <div className="context-menu-separator" />
                  <button className="context-menu-item" onClick={runMenuAction(onConvertDatFilesToDng)}>
                    Generate RAW Files from .DATs
                  </button>
                </>
              ) : null}
              <div className="context-menu-separator" />
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(onClearCurrentLibrary)}>
                Clear Current Library
              </button>
              <div className="context-menu-separator" />
              <button className="context-menu-item" disabled={!photosLoaded || !isDevelopMode} onClick={runMenuAction(onExportCurrent)}>
                Export Current
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(onExportSelected)}>
                Export Selected
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(onExportAll)}>
                Export All
              </button>
              {dngSupported ? (
                <>
                  <div className="context-menu-separator" />
                  <button className="context-menu-item" disabled={!photosLoaded || !isDevelopMode} onClick={runMenuAction(onGenerateRawCurrent)}>
                    Generate RAW from Current
                  </button>
                  <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(onGenerateRawSelected)}>
                    Generate RAW(s) from Selected
                  </button>
                  <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(onGenerateRawAll)}>
                    Generate RAWs for Entire Library
                  </button>
                </>
              ) : null}
              <div className="context-menu-separator" />
              <button className="context-menu-item" onClick={runMenuAction(onToggleShowRemoved)}>
                {showRemoved ? "Hide Removed Photos" : "Show Removed Photos"}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="menu-anchor">
        <button className="menu-button" onClick={() => onOpenMenu(openMenu === "edit" ? null : "edit")}>
          Edit
        </button>
        {openMenu === "edit" && (
          <div className="window menu-dropdown">
            <div className="window-body context-menu-body">
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(onSelectAll)}>
                Select All
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(onClearSelection)}>
                Clear Selection
              </button>
              <div className="context-menu-separator" />
              <button className="context-menu-item" disabled={!isDevelopMode} onClick={runMenuAction(onCopyCurrentEdits)}>
                Copy Edits
              </button>
              <button className="context-menu-item" disabled={!isDevelopMode || !canPasteEdits} onClick={runMenuAction(onPasteCurrentEdits)}>
                Paste Edits
              </button>
              <button className="context-menu-item" disabled={!isDevelopMode} onClick={runMenuAction(onResetCurrent)}>
                Reset Current Photo
              </button>
              <div className="context-menu-separator" />
              <button className="context-menu-item" disabled={!isDevelopMode} onClick={runMenuAction(onRotateCurrentLeft)}>
                Rotate Left
              </button>
              <button className="context-menu-item" disabled={!isDevelopMode} onClick={runMenuAction(onRotateCurrentRight)}>
                Rotate Right
              </button>
              <button className="context-menu-item" disabled={!isDevelopMode} onClick={runMenuAction(onFlipCurrentHorizontal)}>
                Flip Horizontal
              </button>
              <button className="context-menu-item" disabled={!isDevelopMode} onClick={runMenuAction(onFlipCurrentVertical)}>
                Flip Vertical
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="menu-anchor">
        <button className="menu-button" onClick={() => onOpenMenu(openMenu === "view" ? null : "view")}>
          View
        </button>
        {openMenu === "view" && (
          <div className="window menu-dropdown">
            <div className="window-body context-menu-body">
              <button className="context-menu-item" onClick={runMenuAction(onShowLibrary)}>
                Library
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(onShowDevelop)}>
                Develop
              </button>
              <div className="context-menu-separator" />
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(() => onSetMinimumRating(0))}>
                {withCheck(minimumRating === 0, "All Ratings")}
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(() => onSetMinimumRating(1))}>
                {withCheck(minimumRating === 1, "1 Star or More")}
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(() => onSetMinimumRating(2))}>
                {withCheck(minimumRating === 2, "2 Stars or More")}
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(() => onSetMinimumRating(3))}>
                {withCheck(minimumRating === 3, "3 Stars or More")}
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(() => onSetMinimumRating(4))}>
                {withCheck(minimumRating === 4, "4 Stars or More")}
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(() => onSetMinimumRating(5))}>
                {withCheck(minimumRating === 5, "5 Stars Only")}
              </button>
              <div className="context-menu-separator" />
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(() => onSetReviewFilter("all"))}>
                {withCheck(reviewFilter === "all", "All Photos")}
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(() => onSetReviewFilter("picked"))}>
                {withCheck(reviewFilter === "picked", "Picked Only")}
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(() => onSetReviewFilter("rejected"))}>
                {withCheck(reviewFilter === "rejected", "Rejected Only")}
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={runMenuAction(() => onSetReviewFilter("not-rejected"))}>
                {withCheck(reviewFilter === "not-rejected", "Hide Rejected")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ImportDialog({
  state,
  desktopAvailable,
  photosLoaded,
  onClose,
  onChangeIngest,
  onChangeLibraryImportMode,
  onChooseFiles,
  onChooseFolder,
}: {
  state: ImportDialogState;
  desktopAvailable: boolean;
  photosLoaded: boolean;
  onClose: () => void;
  onChangeIngest: (ingestMode: ImportDialogState["ingestMode"]) => void;
  onChangeLibraryImportMode: (libraryImportMode: LibraryImportMode) => void;
  onChooseFiles: () => void;
  onChooseFolder: () => void;
}) {
  if (!state.isOpen) {
    return null;
  }

  return (
    <div className="dialog-backdrop">
      <div className="window dialog-window">
        <div className="title-bar">
          <div className="title-bar-text">Import .DAT Files into Library</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="window-body field-column">
          <p className="field-help">
            Import .DAT files into the library to be viewed and edited using image processing algorithms faithful to the original conversion software.
          </p>

          {photosLoaded ? (
            <div className="field-row-stacked">
              <label htmlFor="library-import-mode">When loading new photos</label>
              <select
                id="library-import-mode"
                value={state.libraryImportMode}
                onChange={(event) => onChangeLibraryImportMode(event.target.value as LibraryImportMode)}
              >
                <option value="add">Add them to the current library</option>
                <option value="replace">Replace the current library</option>
              </select>
            </div>
          ) : null}

          {desktopAvailable ? (
            <>
              <div className="field-row-stacked">
                <label htmlFor="ingest-mode">How to work with the files</label>
                <select
                  id="ingest-mode"
                  value={state.ingestMode}
                  onChange={(event) => onChangeIngest(event.target.value as ImportDialogState["ingestMode"])}
                >
                  <option value="in-place">Work with files where they already are</option>
                  <option value="copy">Copy imported .DAT files to a new folder</option>
                </select>
              </div>

              <p className="field-help">
                Desktop app mode can work directly from removable media or copy the files into a new folder.
              </p>
            </>
          ) : (
            null
          )}

          <div className="dialog-actions">
            <button onClick={onChooseFiles}>Choose Files</button>
            <button onClick={onChooseFolder}>Choose Folder</button>
            <button onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConvertDatToDngDialog({
  isOpen,
  includeSourceBundle,
  onClose,
  onChangeIncludeSourceBundle,
  onChooseFiles,
  onChooseFolder,
}: {
  isOpen: boolean;
  includeSourceBundle: boolean;
  onClose: () => void;
  onChangeIncludeSourceBundle: (checked: boolean) => void;
  onChooseFiles: () => void;
  onChooseFolder: () => void;
}) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="dialog-backdrop">
      <div className="window dialog-window">
        <div className="title-bar">
          <div className="title-bar-text">Generate RAW Files from .DATs</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="window-body field-column">
          <p className="field-help">
            Generate RAW .DNG images from .DAT files to be edited in third-party software using modern image processing for improved dynamic range, exposure latitude, and cleaner details.
          </p>

          <div className="field-row">
            <input
              id="include-source-dats-for-dng"
              type="checkbox"
              checked={includeSourceBundle}
              onChange={(event) => onChangeIncludeSourceBundle(event.target.checked)}
            />
            <label htmlFor="include-source-dats-for-dng">
              Include original *.DAT files in the export.
              (Also includes matching *.DAT.json edit settings files when available)
            </label>
          </div>

          <div className="dialog-actions">
            <button onClick={onChooseFiles}>Choose Files</button>
            <button onClick={onChooseFolder}>Choose Folder</button>
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
  dngSupported,
  currentDisabled,
  selectedDisabled,
  allDisabled,
  onClose,
  onChange,
  onRun,
}: {
  state: ExportDialogState;
  desktopAvailable: boolean;
  dngSupported: boolean;
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
              {dngSupported ? <option value="dng">DNG (raw, unedited, uncompressed, modern)</option> : null}
              {dngSupported ? <option value="dng-png">DNG and PNG</option> : null}
              {dngSupported ? <option value="dng-jpeg">DNG and JPEG</option> : null}
            </select>
          </div>

          <div className="field-row">
            <input
              id="include-source-bundle"
              type="checkbox"
              checked={state.includeSourceBundle}
              onChange={(event) => onChange({ ...state, includeSourceBundle: event.target.checked })}
            />
            <label htmlFor="include-source-bundle">
              Include original *.DAT and *.DAT.json edit settings files in export.
              (Allows you to re-open the folder here and preserve the previous edit settings)
            </label>
          </div>

          {!desktopAvailable ? (
            <p className="field-help">
              Website exports download as a single file when possible, or as a ZIP file when multiple files need to stay together.
            </p>
          ) : null}
          {formatNeedsDngSupport(state.format) ? (
            <p className="field-help">
              The .dng file is raw, unedited, uncompressed, uses the modern raw conversion path, and does not apply the legacy Develop adjustments shown in this editor.
              {state.format === "dng-png" || state.format === "dng-jpeg"
                ? " The companion .png or .jpg uses your current editor adjustments."
                : ""}
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

function ProgressDialog({
  title,
  active,
  message,
  completed,
  total,
  percent,
  summary,
}: {
  title: string;
  active: boolean;
  message: string;
  completed: number;
  total: number;
  percent: number;
  summary?: string;
}) {
  if (!active) {
    return null;
  }

  return (
    <div className="dialog-backdrop">
      <div className="window progress-window">
        <div className="title-bar">
          <div className="title-bar-text">{title}</div>
          <div className="title-bar-controls">
            <button aria-label="Busy" disabled />
          </div>
        </div>
        <div className="window-body field-column">
          <p>{message}</p>
          <div className="sunken-panel progress-meter">
            <div className="progress-meter-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="field-help">{summary ?? `${completed} of ${total} item${total === 1 ? "" : "s"} finished`}</p>
        </div>
      </div>
    </div>
  );
}

function ExportIssuesDialog({
  isOpen,
  title,
  summary,
  failedFiles,
  onClose,
}: {
  isOpen: boolean;
  title: string;
  summary: string;
  failedFiles: string[];
  onClose: () => void;
}) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="dialog-backdrop">
      <div className="window modal-window">
        <div className="title-bar">
          <div className="title-bar-text">{title}</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="window-body field-column">
          <p>{summary}</p>
          {failedFiles.length > 0 ? (
            <div className="sunken-panel" style={{ maxHeight: "14rem", overflowY: "auto", padding: "8px" }}>
              <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
                {failedFiles.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="dialog-actions">
            <button onClick={onClose}>OK</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClearLibraryDialog({
  isOpen,
  photoCount,
  onCancel,
  onConfirm,
}: {
  isOpen: boolean;
  photoCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="dialog-backdrop">
      <div className="window dialog-window" role="dialog" aria-modal="true" aria-labelledby="clear-library-title">
        <div className="title-bar">
          <div id="clear-library-title" className="title-bar-text">Clear Current Library</div>
          <div className="title-bar-controls">
            <button aria-label="Close" onClick={onCancel} />
          </div>
        </div>
        <div className="window-body field-column">
          <p>Clear the current library and start fresh?</p>
          <p className="field-help">
            All currently loaded photos will be cleared out of this library session.
            Your original .DAT files will not be deleted.
          </p>
          <p className="field-help">This will clear {formatCount("loaded photo", photoCount)}.</p>
          <div className="dialog-actions">
            <button onClick={onCancel}>Cancel</button>
            <button onClick={onConfirm}>Clear Current Library</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PhotoContextMenu({
  photo,
  x,
  y,
  canPasteEdits,
  dngSupported,
  onOpenInDevelop,
  onExportRawDng,
  onSetRating,
  onTogglePicked,
  onToggleRejected,
  onToggleRemoved,
  onResetEdits,
  onCopyEdits,
  onPasteEdits,
  onRotateLeft,
  onRotateRight,
  onFlipHorizontal,
  onFlipVertical,
}: {
  photo: PhotoRecord;
  x: number;
  y: number;
  canPasteEdits: boolean;
  dngSupported: boolean;
  onOpenInDevelop: () => void;
  onExportRawDng: () => void;
  onSetRating: (rating: number) => void;
  onTogglePicked: () => void;
  onToggleRejected: () => void;
  onToggleRemoved: () => void;
  onResetEdits: () => void;
  onCopyEdits: () => void;
  onPasteEdits: () => void;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onFlipHorizontal: () => void;
  onFlipVertical: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x, y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }

    const padding = 12;
    const rect = menu.getBoundingClientRect();
    const nextX = Math.max(padding, Math.min(x, window.innerWidth - rect.width - padding));
    const nextY = Math.max(padding, Math.min(y, window.innerHeight - rect.height - padding));

    setPosition((current) => (current.x === nextX && current.y === nextY ? current : { x: nextX, y: nextY }));
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      className="window photo-context-menu"
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="window-body context-menu-body" role="menu" aria-label={`Actions for ${photo.name}`}>
        <div className="context-menu-title">{photo.name}</div>
        <button className="context-menu-item" onClick={onOpenInDevelop}>
          Open In Develop
        </button>
        {dngSupported ? (
          <button className="context-menu-item" onClick={onExportRawDng}>
            Export RAW .DNG
          </button>
        ) : null}
        <div className="context-menu-separator" />
        <div className="context-menu-section-label">Rating</div>
        <RatingStars rating={photo.metadata.rating} onSetRating={onSetRating} />
        <div className="context-menu-separator" />
        <button className="context-menu-item" onClick={onTogglePicked}>
          {photo.metadata.reviewStatus === "flagged" ? "Clear Pick" : "Pick"}
        </button>
        <button className="context-menu-item" onClick={onToggleRejected}>
          {photo.metadata.reviewStatus === "rejected" ? "Clear Reject" : "Reject"}
        </button>
        <div className="context-menu-separator" />
        <button className="context-menu-item" onClick={onResetEdits}>
          Reset Edits
        </button>
        <button className="context-menu-item" onClick={onCopyEdits}>
          Copy Edits
        </button>
        <button className="context-menu-item" disabled={!canPasteEdits} onClick={onPasteEdits}>
          Paste Edits
        </button>
        <div className="context-menu-separator" />
        <button className="context-menu-item" onClick={onRotateLeft}>
          Rotate Left
        </button>
        <button className="context-menu-item" onClick={onRotateRight}>
          Rotate Right
        </button>
        <button className="context-menu-item" onClick={onFlipHorizontal}>
          Flip Horizontal
        </button>
        <button className="context-menu-item" onClick={onFlipVertical}>
          Flip Vertical
        </button>
        <div className="context-menu-separator" />
        <button className="context-menu-item" onClick={onToggleRemoved}>
          {photo.metadata.removed ? "Restore To Library" : "Remove From Library"}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const desktopBridge = getDesktopBridge();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const dngConvertInputRef = useRef<HTMLInputElement | null>(null);
  const dngConvertFolderInputRef = useRef<HTMLInputElement | null>(null);
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
  const [showRemoved, setShowRemoved] = useState(false);
  const [minimumRating, setMinimumRating] = useState(0);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [copiedEdits, setCopiedEdits] = useState<PhotoEdits | null>(null);
  const [status, setStatus] = useState("Open DJ-1000 photos to browse, adjust, and export them.");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [importDialog, setImportDialog] = useState<ImportDialogState>({
    isOpen: false,
    kind: "files",
    ingestMode: "in-place",
    libraryImportMode: "add",
  });
  const [convertDatDialogOpen, setConvertDatDialogOpen] = useState(false);
  const [clearLibraryDialogOpen, setClearLibraryDialogOpen] = useState(false);
  const [exportIncludeSourceBundlePreference, setExportIncludeSourceBundlePreference] = useState(() =>
    loadStoredBooleanPreference(exportIncludeSourceBundleStorageKey),
  );
  const [rawConverterIncludeSourceBundlePreference, setRawConverterIncludeSourceBundlePreference] = useState(() =>
    loadStoredBooleanPreference(rawConverterIncludeSourceBundleStorageKey),
  );
  const [exportDialog, setExportDialog] = useState<ExportDialogState>({
    isOpen: false,
    scope: "current",
    format: "png",
    includeSourceBundle: loadStoredBooleanPreference(exportIncludeSourceBundleStorageKey),
  });
  const [preferredExportFormat, setPreferredExportFormat] = useState<ExportDialogState["format"]>("png");
  const [exportProgress, setExportProgress] = useState({
    active: false,
    message: "",
    completed: 0,
    total: 0,
    percent: 0,
  });
  const [exportIssuesDialog, setExportIssuesDialog] = useState({
    isOpen: false,
    title: "",
    summary: "",
    failedFiles: [] as string[],
  });
  const [exampleImportProgress, setExampleImportProgress] = useState({
    active: false,
    message: "",
    completed: 0,
    total: 0,
    percent: 0,
  });

  const updateExportIncludeSourceBundlePreference = useCallback((checked: boolean) => {
    setExportIncludeSourceBundlePreference(checked);
    try {
      window.localStorage.setItem(exportIncludeSourceBundleStorageKey, checked ? "true" : "false");
    } catch {
      // Ignore storage failures and keep the in-memory preference.
    }
  }, []);

  const updateRawConverterIncludeSourceBundlePreference = useCallback((checked: boolean) => {
    setRawConverterIncludeSourceBundlePreference(checked);
    try {
      window.localStorage.setItem(rawConverterIncludeSourceBundleStorageKey, checked ? "true" : "false");
    } catch {
      // Ignore storage failures and keep the in-memory preference.
    }
  }, []);
  const [hasLoadedOwnPhotos, setHasLoadedOwnPhotos] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(hasLoadedOwnPhotosStorageKey) === "true";
  });
  const [isBrowserOnline, setIsBrowserOnline] = useState(getBrowserOnlineState);
  const [dngSupported, setDngSupported] = useState(false);
  const [previewZoomMode, setPreviewZoomMode] = useState<"fit" | "custom">("fit");
  const [previewZoomPercent, setPreviewZoomPercent] = useState(100);
  const [fitZoomPercent, setFitZoomPercent] = useState(100);
  const [isMobileLayout, setIsMobileLayout] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 720px)").matches : false,
  );
  const shellToolbarRef = useRef<HTMLDivElement | null>(null);
  const importConvertMenuAnchorRef = useRef<HTMLDivElement | null>(null);
  const exportMenuAnchorRef = useRef<HTMLDivElement | null>(null);
  const lastLibraryTapRef = useRef<{ photoId: string; timestamp: number } | null>(null);
  const activePhotoIdRef = useRef<string | null>(null);
  const [toolbarMenuAlignment, setToolbarMenuAlignment] = useState({
    importConvert: false,
    export: false,
  });

  const openExportIssuesDialog = useCallback((title: string, summary: string, failedFiles: string[]) => {
    setExportIssuesDialog({
      isOpen: true,
      title,
      summary,
      failedFiles,
    });
  }, []);

  const updateToolbarMenuAlignment = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    const measureNeedsRightAlign = (anchor: HTMLDivElement | null) => {
      if (!anchor) {
        return false;
      }
      const dropdown = anchor.querySelector<HTMLElement>(".menu-dropdown");
      if (!dropdown) {
        return false;
      }
      const anchorRect = anchor.getBoundingClientRect();
      const dropdownWidth = dropdown.offsetWidth;
      return anchorRect.left + dropdownWidth > window.innerWidth - 8;
    };

    setToolbarMenuAlignment((current) => {
      const next = {
        importConvert: openMenu === "import-convert" ? measureNeedsRightAlign(importConvertMenuAnchorRef.current) : current.importConvert,
        export: openMenu === "export" ? measureNeedsRightAlign(exportMenuAnchorRef.current) : current.export,
      };

      if (openMenu !== "import-convert") {
        next.importConvert = false;
      }
      if (openMenu !== "export") {
        next.export = false;
      }

      return current.importConvert === next.importConvert && current.export === next.export ? current : next;
    });
  }, [openMenu]);

  const updateActivePhotoId = useCallback((photoId: string | null) => {
    activePhotoIdRef.current = photoId;
    setActivePhotoId(photoId);
  }, []);

  const activePhoto = useMemo(
    () => photos.find((photo) => photo.id === activePhotoId) ?? null,
    [photos, activePhotoId],
  );
  const sortedPhotos = useMemo(
    () => [...photos].sort(comparePhotoNames),
    [photos],
  );
  const visiblePhotos = useMemo(
    () =>
      sortedPhotos.filter((photo) => {
        if (!showRemoved && photo.metadata.removed) {
          return false;
        }
        if (photo.metadata.rating < minimumRating) {
          return false;
        }
        return matchesReviewFilter(photo, reviewFilter);
      }),
    [minimumRating, reviewFilter, showRemoved, sortedPhotos],
  );
  const visiblePhotoIds = useMemo(
    () => new Set(visiblePhotos.map((photo) => photo.id)),
    [visiblePhotos],
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
    () => visiblePhotos.filter((photo) => selectedIds.has(photo.id)),
    [visiblePhotos, selectedIds],
  );
  const hasOwnPhotosInLibrary = useMemo(
    () => photos.some((photo) => !photo.relativePath.startsWith(examplePhotoPathPrefix)),
    [photos],
  );
  const shouldShowExampleButton = isBrowserOnline && !hasLoadedOwnPhotos && !hasOwnPhotosInLibrary;
  const contextMenuPhoto = useMemo(
    () => (contextMenu ? photos.find((photo) => photo.id === contextMenu.photoId) ?? null : null),
    [contextMenu, photos],
  );
  const libraryStats = useMemo(
    () => ({
      total: visiblePhotos.length,
      selected: visiblePhotos.filter((photo) => selectedIds.has(photo.id)).length,
      ready: visiblePhotos.filter((photo) => photo.thumbnailStatus === "ready").length,
      removed: photos.filter((photo) => photo.metadata.removed).length,
      picked: photos.filter((photo) => photo.metadata.reviewStatus === "flagged").length,
      rejected: photos.filter((photo) => photo.metadata.reviewStatus === "rejected").length,
    }),
    [photos, selectedIds, visiblePhotos],
  );

  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  useEffect(() => {
    function updateOnlineState() {
      setIsBrowserOnline(getBrowserOnlineState());
    }

    window.addEventListener("online", updateOnlineState);
    window.addEventListener("offline", updateOnlineState);
    updateOnlineState();

    return () => {
      window.removeEventListener("online", updateOnlineState);
      window.removeEventListener("offline", updateOnlineState);
    };
  }, []);

  useEffect(() => {
    activePhotoIdRef.current = activePhotoId;
  }, [activePhotoId]);

  useEffect(() => {
    if (!hasLoadedOwnPhotos && hasOwnPhotosInLibrary) {
      markOwnPhotosLoaded();
    }
  }, [hasLoadedOwnPhotos, hasOwnPhotosInLibrary]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 720px)");
    const updateLayoutMode = () => setIsMobileLayout(mediaQuery.matches);

    updateLayoutMode();
    mediaQuery.addEventListener("change", updateLayoutMode);
    return () => mediaQuery.removeEventListener("change", updateLayoutMode);
  }, []);

  useLayoutEffect(() => {
    if (openMenu !== "import-convert" && openMenu !== "export") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      updateToolbarMenuAlignment();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [openMenu, updateToolbarMenuAlignment]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleResize = () => updateToolbarMenuAlignment();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [updateToolbarMenuAlignment]);

  useEffect(() => {
    if (!isMobileLayout) {
      return;
    }

    setPreviewZoomMode("fit");
    setPreviewZoomPercent(fitZoomPercent);
  }, [fitZoomPercent, isMobileLayout]);

  useEffect(() => {
    if (!openMenu) {
      return;
    }

    const closeMenu = (event: PointerEvent) => {
      const toolbar = shellToolbarRef.current;
      if (toolbar && event.target instanceof Node && toolbar.contains(event.target)) {
        return;
      }
      setOpenMenu(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
      }
    };

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    function closeMenu() {
      setContextMenu(null);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeMenu();
      }
    }

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (showRemoved) {
      return;
    }

    setSelectedIds((current) => {
      const next = new Set(Array.from(current).filter((photoId) => visiblePhotoIds.has(photoId)));
      return next.size === current.size ? current : next;
    });
  }, [showRemoved, visiblePhotoIds]);

  useEffect(() => {
    if (activePhotoId && visiblePhotoIds.has(activePhotoId)) {
      return;
    }

    const nextActive = visiblePhotos[0] ?? null;
    updateActivePhotoId(nextActive?.id ?? null);

    if (!nextActive) {
      setView("library");
      return;
    }

    setSelectedIds((current) => {
      if (current.has(nextActive.id) && current.size === 1) {
        return current;
      }
      return new Set([nextActive.id]);
    });
  }, [activePhoto, activePhotoId, updateActivePhotoId, visiblePhotoIds, visiblePhotos]);

  useEffect(() => {
    const pool = new Dj1000RenderPool();
    renderPoolRef.current = pool;
    void pool.getCapabilities()
      .then((capabilities) => {
        setDngSupported(capabilities.supportsDng);
      })
      .catch(() => {
        setDngSupported(false);
      });
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

  useEffect(() => {
    if (!dngSupported) {
      if (formatNeedsDngSupport(exportDialog.format)) {
        setExportDialog((current) => ({ ...current, format: "png" }));
      }
      if (formatNeedsDngSupport(preferredExportFormat)) {
        setPreferredExportFormat("png");
      }
    }
  }, [dngSupported, exportDialog.format, preferredExportFormat]);

  const replacePhoto = useCallback((photoId: string, updater: (photo: PhotoRecord) => PhotoRecord) => {
    setPhotos((current) => {
      const next = current.map((photo) => (photo.id === photoId ? updater(photo) : photo));
      photosRef.current = next;
      return next;
    });
  }, []);

  async function frameToThumbnailUrl(frame: RenderedFrame, edits: PhotoEdits) {
    const canvas = document.createElement("canvas");
    const maxWidth = 240;
    const transformed = createTransformedFrameCanvas(frame, edits);
    const aspectRatio = transformed.height / transformed.width;
    canvas.width = maxWidth;
    canvas.height = Math.max(1, Math.round(maxWidth * aspectRatio));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to create a canvas for thumbnail generation.");
    }
    context.drawImage(transformed, 0, 0, canvas.width, canvas.height);
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
      const thumbnailUrl = await frameToThumbnailUrl(frame, photo.edits);
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
        const message = String(error instanceof Error ? error.message : error);
        if (message.includes("No worker session exists") || message.includes("No open session")) {
          window.setTimeout(() => {
            if (desiredPreviewRef.current?.signature === desired.signature) {
              void requestLatestPreview();
            }
          }, 80);
          return;
        }

        if (desiredPreviewRef.current?.signature !== desired.signature) {
          return;
        }

        replacePhoto(desired.photoId, (photo) => ({
          ...photo,
          previewStatus: "error",
          error: message,
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

  const queuePreviewRender = useCallback((photo: Pick<PhotoRecord, "id" | "name" | "edits">) => {
    const edits: PhotoEdits = {
      size: photo.edits.size,
      redBalance: photo.edits.redBalance,
      greenBalance: photo.edits.greenBalance,
      blueBalance: photo.edits.blueBalance,
      contrast: photo.edits.contrast,
      brightness: photo.edits.brightness,
      vividness: photo.edits.vividness,
      sharpness: photo.edits.sharpness,
      rotation: 0,
      flipHorizontal: false,
      flipVertical: false,
    };

    const signature = buildPreviewSignature(photo.id, edits);
    desiredPreviewRef.current = {
      photoId: photo.id,
      edits,
      name: photo.name,
      signature,
    };

    setStatus(`Rendering ${photo.name} in the develop view...`);
    replacePhoto(photo.id, (entry) => ({ ...entry, previewStatus: "loading", error: undefined }));
    void requestLatestPreview();
  }, [replacePhoto, requestLatestPreview]);

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
    queuePreviewRender({
      id: activePhotoId,
      name: activePhotoName,
      edits: {
        size: activeEditSize,
        redBalance: activeRedBalance,
        greenBalance: activeGreenBalance,
        blueBalance: activeBlueBalance,
        contrast: activeContrast,
        brightness: activeBrightness,
        vividness: activeVividness,
        sharpness: activeSharpness,
        rotation: 0,
        flipHorizontal: false,
        flipVertical: false,
      },
    });
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
    queuePreviewRender,
  ]);

  useEffect(() => {
    if (view !== "develop") {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        openMenu !== null ||
        contextMenu !== null ||
        clearLibraryDialogOpen ||
        importDialog.isOpen ||
        convertDatDialogOpen ||
        exportDialog.isOpen ||
        exportProgress.active ||
        exampleImportProgress.active ||
        exportIssuesDialog.isOpen
      ) {
        return;
      }

      if (event.target instanceof HTMLElement) {
        const interactiveTarget = event.target.closest("input, textarea, select, [contenteditable='true']");
        if (interactiveTarget) {
          return;
        }
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        const currentIndex = visiblePhotos.findIndex((photo) => photo.id === activePhotoIdRef.current);
        const nextPhoto = currentIndex > 0 ? visiblePhotos[currentIndex - 1] : null;
        if (nextPhoto) {
          updateActivePhotoId(nextPhoto.id);
          if (nextPhoto.previewStatus === "idle") {
            queuePreviewRender(nextPhoto);
          }
          setSelectedIds(new Set([nextPhoto.id]));
        }
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        const currentIndex = visiblePhotos.findIndex((photo) => photo.id === activePhotoIdRef.current);
        const nextPhoto =
          currentIndex >= 0 && currentIndex < visiblePhotos.length - 1 ? visiblePhotos[currentIndex + 1] : null;
        if (nextPhoto) {
          updateActivePhotoId(nextPhoto.id);
          if (nextPhoto.previewStatus === "idle") {
            queuePreviewRender(nextPhoto);
          }
          setSelectedIds(new Set([nextPhoto.id]));
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    clearLibraryDialogOpen,
    contextMenu,
    convertDatDialogOpen,
    exampleImportProgress.active,
    exportDialog.isOpen,
    exportIssuesDialog.isOpen,
    exportProgress.active,
    importDialog.isOpen,
    openMenu,
    queuePreviewRender,
    updateActivePhotoId,
    view,
    visiblePhotos,
  ]);

  async function hydrateImportedPhotos(
    payloads: ReturnType<typeof createPhotoRecord>[],
    preferredActiveId?: string | null,
    onProgress?: (processed: number, total: number, photo: ReturnType<typeof createPhotoRecord>) => void,
  ): Promise<number> {
    const pool = renderPoolRef.current;
    if (!pool || payloads.length === 0) {
      return 0;
    }

    setStatus(`Opening ${formatCount("photo", payloads.length)}...`);
    let successCount = 0;
    for (const [index, payload] of payloads.entries()) {
      try {
        await pool.openDocument(payload.id, payload.datBytes);
        successCount += 1;
        if (preferredActiveId && payload.id === preferredActiveId && !activePhotoIdRef.current) {
          updateActivePhotoId(preferredActiveId);
          queuePreviewRender(payload);
        }
        void queueThumbnailRender(payload.id);
      } catch (error) {
        replacePhoto(payload.id, (photo) => ({
          ...photo,
          thumbnailStatus: "error",
          previewStatus: "error",
          error: String(error instanceof Error ? error.message : error),
        }));
      } finally {
        onProgress?.(index + 1, payloads.length, payload);
      }
    }

    return successCount;
  }

  function markOwnPhotosLoaded() {
    setHasLoadedOwnPhotos(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(hasLoadedOwnPhotosStorageKey, "true");
    }
  }

  function requestClearCurrentLibrary() {
    if (photosRef.current.length === 0) {
      return;
    }

    setContextMenu(null);
    setOpenMenu(null);
    setClearLibraryDialogOpen(true);
  }

  function confirmClearCurrentLibrary() {
    const currentPhotos = photosRef.current;
    setClearLibraryDialogOpen(false);
    if (currentPhotos.length === 0) {
      return;
    }

    for (const timer of saveTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    saveTimersRef.current.clear();
    for (const timer of thumbnailTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    thumbnailTimersRef.current.clear();
    for (const photo of currentPhotos) {
      renderPoolRef.current?.closeDocument(photo.id);
    }

    photosRef.current = [];
    desiredPreviewRef.current = null;
    activePreviewSignatureRef.current = null;
    lastLibraryTapRef.current = null;
    setPhotos([]);
    updateActivePhotoId(null);
    setSelectedIds(new Set());
    setView("library");
    setShowRemoved(false);
    setMinimumRating(0);
    setReviewFilter("all");
    setContextMenu(null);
    setCopiedEdits(null);
    setOpenMenu(null);
    setClearLibraryDialogOpen(false);
    setImportDialog((current) => ({ ...current, isOpen: false, libraryImportMode: "add" }));
    setConvertDatDialogOpen(false);
    setExportDialog((current) => ({ ...current, isOpen: false, scope: "current" }));
    setExportProgress({ active: false, message: "", completed: 0, total: 0, percent: 0 });
    setExampleImportProgress({ active: false, message: "", completed: 0, total: 0, percent: 0 });
    setExportIssuesDialog({ isOpen: false, title: "", summary: "", failedFiles: [] });
    setStatus("Library cleared. Import .DAT files to start a fresh library.");
  }

  async function ingestPayloads(
    payloads: ReturnType<typeof createPhotoRecord>[],
    options?: { markAsOwnImport?: boolean; libraryImportMode?: LibraryImportMode },
  ) {
    if (payloads.length === 0) {
      setStatus("No .DAT files were found in that import selection.");
      return;
    }

    const libraryImportMode = options?.libraryImportMode ?? "add";
    const shouldReplaceLibrary = libraryImportMode === "replace";
    const preferredActiveId = shouldReplaceLibrary || !activePhotoId ? [...payloads].sort(comparePhotoNames)[0].id : null;

    if (shouldReplaceLibrary) {
      desiredPreviewRef.current = null;
      activePreviewSignatureRef.current = null;
      updateActivePhotoId(null);
      for (const photo of photosRef.current) {
        renderPoolRef.current?.closeDocument(photo.id);
      }
    }

    if (shouldReplaceLibrary) {
      photosRef.current = payloads;
      setPhotos(payloads);
      setSelectedIds(new Set(payloads.map((photo) => photo.id)));
    } else {
      const nextPhotos = [...photosRef.current, ...payloads];
      photosRef.current = nextPhotos;
      setPhotos(nextPhotos);
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const photo of payloads) {
          next.add(photo.id);
        }
        return next;
      });
    }

    const successCount = await hydrateImportedPhotos(payloads, preferredActiveId);
    if (options?.markAsOwnImport && successCount > 0) {
      markOwnPhotosLoaded();
    }
    setStatus(`Imported ${formatCount("photo", payloads.length)}.`);
  }

  async function runDesktopImport(kind: ImportKind) {
    if (!desktopBridge) {
      return;
    }

    const importedAt = Date.now();
    const importOptions = {
      ingestMode: importDialog.ingestMode,
      libraryImportMode: importDialog.libraryImportMode,
    };
    setImportDialog((current) => ({ ...current, isOpen: false }));
    const result = await desktopBridge.pickImport({
      kind,
      ingestMode: importOptions.ingestMode,
    });
    const payloads = result.entries.map((entry) =>
      createPhotoRecord({
        name: entry.name,
        relativePath: entry.relativePath,
        importedAt,
        filePath: entry.filePath,
        sidecarPath: entry.sidecarPath,
        ingestMode: entry.ingestMode,
        bytes: new Uint8Array(entry.bytes),
        sidecarText: entry.sidecarText,
      }),
    );
    await ingestPayloads(payloads, { markAsOwnImport: true, libraryImportMode: importOptions.libraryImportMode });
  }

  async function handleBrowserFileInput(_kind: ImportKind, event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }

    const libraryImportMode = importDialog.libraryImportMode;
    const importedAt = Date.now();
    const payloads = (await parseBrowserImport(files, "in-place")).map((payload) => createPhotoRecord({ ...payload, importedAt }));
    event.target.value = "";
    await ingestPayloads(payloads, { markAsOwnImport: true, libraryImportMode });
  }

  async function loadExamplePhotos() {
    if (!getBrowserOnlineState()) {
      setStatus("Example .DAT Files are only available while online.");
      return;
    }

    const totalSteps = exampleDatFiles.length * 2;
    const updateProgress = (message: string, completed: number) => {
      setExampleImportProgress({
        active: true,
        message,
        completed,
        total: totalSteps,
        percent: totalSteps === 0 ? 0 : Math.round((completed / totalSteps) * 100),
      });
    };

    setOpenMenu(null);
    updateProgress("Preparing Example .DAT Files...", 0);

    try {
      const payloads: ReturnType<typeof createPhotoRecord>[] = [];
      const importedAt = Date.now();

      for (const [index, name] of exampleDatFiles.entries()) {
        updateProgress(`Downloading ${name}...`, index);
        const response = await fetch(new URL(`examples/${name}`, document.baseURI).toString());
        if (!response.ok) {
          throw new Error(`Could not download ${name}.`);
        }

        payloads.push(
          createPhotoRecord({
            name,
            relativePath: `Example .DAT Files/${name}`,
            importedAt,
            ingestMode: "copy",
            bytes: new Uint8Array(await response.arrayBuffer()),
          }),
        );
        updateProgress(`Downloaded ${name}.`, index + 1);
      }

      const preferredActiveId = !activePhotoId ? [...payloads].sort(comparePhotoNames)[0]?.id ?? null : null;

      const nextPhotos = [...photosRef.current, ...payloads];
      photosRef.current = nextPhotos;
      setPhotos(nextPhotos);
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const photo of payloads) {
          next.add(photo.id);
        }
        return next;
      });

      await hydrateImportedPhotos(payloads, preferredActiveId, (processed, total, photo) => {
        updateProgress(`Opening ${photo.name}...`, exampleDatFiles.length + processed);
        if (processed === total) {
          setStatus(`Loaded ${formatCount("example photo", payloads.length)}.`);
        }
      });
    } catch (error) {
      setStatus(`Example photos failed to load: ${String(error instanceof Error ? error.message : error)}`);
    } finally {
      setExampleImportProgress({
        active: false,
        message: "",
        completed: 0,
        total: 0,
        percent: 0,
      });
    }
  }

  function openImport(kind: ImportKind = "files") {
    setOpenMenu(null);
    setImportDialog((current) => ({ ...current, isOpen: true, kind, libraryImportMode: "add" }));
  }

  function launchBrowserImport(kind: ImportKind) {
    if (kind === "folder") {
      folderInputRef.current?.click();
      return;
    }
    fileInputRef.current?.click();
  }

  function handleImportRun(kind: ImportKind) {
    if (desktopBridge) {
      void runDesktopImport(kind);
      return;
    }
    setImportDialog((current) => ({ ...current, isOpen: false }));
    launchBrowserImport(kind);
  }

  async function runDesktopDngConversion(kind: ImportKind) {
    if (!desktopBridge) {
      return;
    }

    setConvertDatDialogOpen(false);
    const result = await desktopBridge.pickImport({
      kind,
      ingestMode: "in-place",
    });

    const payloads = result.entries.map((entry) => ({
      name: entry.name,
      relativePath: entry.relativePath,
      ingestMode: entry.ingestMode,
      bytes: new Uint8Array(entry.bytes),
      sidecarText: entry.sidecarText,
    }));
    await runStandaloneDngZipConversion(payloads);
  }

  function launchBrowserDngConvert(kind: ImportKind) {
    if (kind === "folder") {
      dngConvertFolderInputRef.current?.click();
      return;
    }
    dngConvertInputRef.current?.click();
  }

  function openConvertDatToDng() {
    setOpenMenu(null);
    if (!dngSupported) {
      setStatus("DNG export is unavailable in this build.");
      return;
    }
    setConvertDatDialogOpen(true);
  }

  function handleConvertDatToDngRun(kind: ImportKind) {
    if (desktopBridge) {
      void runDesktopDngConversion(kind);
      return;
    }
    setConvertDatDialogOpen(false);
    launchBrowserDngConvert(kind);
  }

  async function runStandaloneDngZipConversion(
    payloads: Array<Awaited<ReturnType<typeof parseBrowserImport>>[number]>,
  ) {
    if (payloads.length === 0) {
      setStatus("No .DAT files were selected for DNG conversion.");
      return;
    }

    const pool = renderPoolRef.current;
    if (!pool || !dngSupported) {
      setStatus("DNG conversion is not ready yet.");
      return;
    }

    setStatus(`Converting ${formatCount(".DAT file", payloads.length)} to DNG...`);
    setExportProgress({
      active: true,
      message: `Converting 1 of ${payloads.length}...`,
      completed: 0,
      total: payloads.length,
      percent: 0,
    });

    try {
      const archiveFiles = [];
      const failedFiles: string[] = [];
      let convertedCount = 0;
      for (const [index, payload] of payloads.entries()) {
        setExportProgress({
          active: true,
          message: `Converting ${payload.name} (${index + 1} of ${payloads.length})...`,
          completed: index,
          total: payloads.length,
          percent: Math.round((index / Math.max(payloads.length, 1)) * 100),
        });

        try {
          const dngBytes = await pool.convertDatToDng(payload.bytes);
          archiveFiles.push({
            name: `${buildIdentifiedExportStem(payload.relativePath, payload.bytes)}.dng`,
            blob: new Blob([Uint8Array.from(dngBytes)], { type: "image/x-adobe-dng" }),
          });
          if (rawConverterIncludeSourceBundlePreference) {
            archiveFiles.push({
              name: payload.relativePath,
              blob: new Blob([Uint8Array.from(payload.bytes)], { type: "application/octet-stream" }),
            });
            if (payload.sidecarText) {
              archiveFiles.push({
                name: `${payload.relativePath}.json`,
                blob: new Blob([payload.sidecarText], { type: "application/json" }),
              });
            }
          }
          convertedCount += 1;
        } catch (error) {
          console.error(`DNG conversion failed for ${payload.name}:`, error);
          failedFiles.push(payload.name);
        }
      }

      if (archiveFiles.length === 0) {
        setStatus(
          `DNG conversion failed for all selected files. Failed: ${summarizeFailedFiles(failedFiles)}.`,
        );
        openExportIssuesDialog(
          "RAW Generation Failed",
          "None of the selected .DAT files could be converted to .DNG RAW files.",
          failedFiles,
        );
        return;
      }

      const archive = await buildBrowserExportArchiveWithProgress(archiveFiles, (percent) => {
        setExportProgress({
          active: true,
          message: `Creating DNG ZIP... ${Math.round(percent)}%`,
          completed: payloads.length,
          total: payloads.length,
          percent: Math.round(percent),
        });
      });

      const fileName = buildDngArchiveName(convertedCount);
      if (desktopBridge) {
        await desktopBridge.exportFiles({
          files: [
            {
              relativePath: fileName,
              bytes: await archive.arrayBuffer(),
            },
          ],
          suggestedFolderName: "dj1000-dng-export",
        });
      } else {
        triggerBrowserDownload(archive, fileName);
      }

      if (failedFiles.length > 0) {
        setStatus(
          `Converted ${formatCount(".DAT file", convertedCount)} to DNG ZIP. Skipped ${formatCount("failed file", failedFiles.length)}: ${summarizeFailedFiles(failedFiles)}.`,
        );
        openExportIssuesDialog(
          "RAW Generation Completed with Skipped Files",
          `Converted ${formatCount(".DAT file", convertedCount)} to .DNG RAW and skipped ${formatCount("file", failedFiles.length)}.`,
          failedFiles,
        );
      } else {
        setStatus(`Converted ${formatCount(".DAT file", convertedCount)} to DNG ZIP.`);
      }
    } catch (error) {
      setStatus(`DNG conversion failed: ${String(error instanceof Error ? error.message : error)}`);
    } finally {
      setExportProgress({
        active: false,
        message: "",
        completed: 0,
        total: 0,
        percent: 0,
      });
    }
  }

  async function handleBrowserDngConvertInput(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }

    const payloads = await parseBrowserImport(files, "copy");
    event.target.value = "";
    await runStandaloneDngZipConversion(payloads);
  }

  function schedulePhotoPersistence(photo: PhotoRecord) {
    if (!desktopBridge || photo.ingestMode !== "in-place" || !photo.filePath) {
      return;
    }

    const existing = saveTimersRef.current.get(photo.id);
    if (existing) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      void desktopBridge.persistSidecar({
        filePath: photo.filePath!,
        sidecarText: stringifySidecar(photo.edits, photo.metadata, photo.sidecar),
      });
    }, 240);
    saveTimersRef.current.set(photo.id, timer);
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
    schedulePhotoPersistence(nextPhoto);
  }

  function updatePhotoMetadata(photoId: string, patch: Partial<PhotoMetadata>) {
    const photo = photosRef.current.find((entry) => entry.id === photoId);
    if (!photo) {
      return;
    }

    const nextPhoto = {
      ...photo,
      metadata: {
        ...photo.metadata,
        ...patch,
      },
    };
    replacePhoto(photoId, () => nextPhoto);
    schedulePhotoPersistence(nextPhoto);

    if (!showRemoved && nextPhoto.metadata.removed) {
      setSelectedIds((current) => {
        if (!current.has(photoId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(photoId);
        return next;
      });
    }
  }

  function setPhotoRating(photoId: string, rating: number) {
    const photo = photosRef.current.find((entry) => entry.id === photoId);
    if (!photo) {
      return;
    }

    const nextRating = rating === 1 && photo.metadata.rating === 1 ? 0 : rating;
    updatePhotoMetadata(photoId, { rating: nextRating });
  }

  function togglePhotoReviewStatus(photoId: string, reviewStatus: PhotoReviewStatus) {
    const photo = photosRef.current.find((entry) => entry.id === photoId);
    if (!photo) {
      return;
    }

    updatePhotoMetadata(photoId, {
      reviewStatus: photo.metadata.reviewStatus === reviewStatus ? "none" : reviewStatus,
    });
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
      rotation: 0,
      flipHorizontal: false,
      flipVertical: false,
    });
  }

  function resetPhotoEdits(photoId: string) {
    updatePhotoEdits(photoId, {
      size: "large",
      redBalance: 100,
      greenBalance: 100,
      blueBalance: 100,
      contrast: 0,
      brightness: 0,
      vividness: 0,
      sharpness: 0,
      rotation: 0,
      flipHorizontal: false,
      flipVertical: false,
    });
  }

  function copyPhotoEdits(photoId: string) {
    const photo = photosRef.current.find((entry) => entry.id === photoId);
    if (!photo) {
      return;
    }
    setCopiedEdits({ ...photo.edits });
    setStatus(`Copied edits from ${photo.name}.`);
  }

  function pastePhotoEdits(photoId: string) {
    if (!copiedEdits) {
      return;
    }
    updatePhotoEdits(photoId, { ...copiedEdits });
    const photo = photosRef.current.find((entry) => entry.id === photoId);
    if (photo) {
      setStatus(`Pasted edits onto ${photo.name}.`);
    }
  }

  function rotatePhoto(photoId: string, direction: "left" | "right") {
    const photo = photosRef.current.find((entry) => entry.id === photoId);
    if (!photo) {
      return;
    }
    const nextRotation = direction === "left"
      ? ((photo.edits.rotation + 270) % 360) as 0 | 90 | 180 | 270
      : ((photo.edits.rotation + 90) % 360) as 0 | 90 | 180 | 270;
    updatePhotoEdits(photoId, { rotation: nextRotation });
  }

  function togglePhotoFlip(photoId: string, axis: "horizontal" | "vertical") {
    const photo = photosRef.current.find((entry) => entry.id === photoId);
    if (!photo) {
      return;
    }
    if (axis === "horizontal") {
      updatePhotoEdits(photoId, { flipHorizontal: !photo.edits.flipHorizontal });
      return;
    }
    updatePhotoEdits(photoId, { flipVertical: !photo.edits.flipVertical });
  }

  function handleSelectPhoto(photoId: string, event?: MouseEvent<HTMLButtonElement>) {
    setContextMenu(null);

    const isTouchLike =
      typeof window !== "undefined" &&
      (window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(hover: none)").matches);
    const now = Date.now();
    const previousTap = lastLibraryTapRef.current;
    const isRepeatedTouchTap =
      isTouchLike &&
      previousTap?.photoId === photoId &&
      now - previousTap.timestamp <= 450;

    lastLibraryTapRef.current = { photoId, timestamp: now };

    if (isRepeatedTouchTap) {
      setView("develop");
      updateActivePhotoId(photoId);
      setSelectedIds(new Set([photoId]));
      lastLibraryTapRef.current = null;
      return;
    }

    updateActivePhotoId(photoId);
    const photo = photosRef.current.find((entry) => entry.id === photoId);
    if (photo && photo.previewStatus === "idle") {
      queuePreviewRender(photo);
    }

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

  function handleOpenPhotoContextMenu(photoId: string, event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setOpenMenu(null);
    updateActivePhotoId(photoId);
    setSelectedIds((current) => (current.has(photoId) ? current : new Set([photoId])));
    setContextMenu({
      photoId,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function collectExportTargets(scope: ExportScope) {
    if (scope === "current") {
      return activePhoto ? [activePhoto] : [];
    }
    if (scope === "selected") {
      return selectedPhotos.filter((photo) => !photo.metadata.removed);
    }
    return sortedPhotos.filter((photo) => !photo.metadata.removed);
  }

  function openExportDialogForScope(scope: ExportScope, format?: ExportDialogState["format"]) {
    setExportDialog((current) => ({
      ...current,
      isOpen: true,
      scope,
      format: format ?? preferredExportFormat,
      includeSourceBundle: exportIncludeSourceBundlePreference,
    }));
  }

  function handleExportDialogChange(next: ExportDialogState) {
    if (next.includeSourceBundle !== exportIncludeSourceBundlePreference) {
      updateExportIncludeSourceBundlePreference(next.includeSourceBundle);
    }
    setExportDialog(next);
    setPreferredExportFormat(next.format);
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
    setExportDialog((current) => ({ ...current, isOpen: false }));
    setStatus(`Preparing ${formatCount("photo", targets.length)} for export...`);
    setExportProgress({
      active: true,
      message: `Preparing 1 of ${targets.length}...`,
      completed: 0,
      total: targets.length,
      percent: 0,
    });

    try {
      const failedFiles: string[] = [];
      let succeededCount = 0;
      const wantsDng = formatNeedsDngSupport(exportDialog.format);
      const renderedFormat = getRenderedExportFormat(exportDialog.format);
      for (const [index, photo] of targets.entries()) {
        setExportProgress({
          active: true,
          message: `Preparing ${photo.name} (${index + 1} of ${targets.length})...`,
          completed: index,
          total: targets.length,
          percent: Math.round((index / Math.max(targets.length, 1)) * 100),
        });

        try {
          if (wantsDng && !dngSupported) {
            throw new Error("DNG export is unavailable in this build.");
          }

          if (wantsDng) {
            const dngBytes = await renderPoolRef.current!.convertDatToDng(photo.datBytes, photo.id);
            if (desktopBridge) {
              desktopFiles.push(...buildDesktopDngExportPayload(photo, dngBytes, false));
            } else {
              browserFiles.push(...buildBrowserDngExportBundle(photo, dngBytes, false));
            }
          }

          if (renderedFormat) {
            const frame = await renderPoolRef.current!.render(photo.id, photo.edits, "export");
            if (desktopBridge) {
              desktopFiles.push(...await buildDesktopExportPayload(photo, frame, renderedFormat, false));
            } else {
              browserFiles.push(...await buildBrowserExportBundle(photo, frame, renderedFormat, false));
            }
          }

          if (exportDialog.includeSourceBundle) {
            if (desktopBridge) {
              desktopFiles.push(...buildDesktopSourceBundle(photo));
            } else {
              browserFiles.push(...buildBrowserSourceBundle(photo));
            }
          }

          succeededCount += 1;
        } catch (error) {
          console.error(`Export failed for ${photo.name}:`, error);
          failedFiles.push(photo.name);
        }
      }

      if (desktopBridge ? desktopFiles.length === 0 : browserFiles.length === 0) {
        setStatus(
          `Export failed for all selected files. Failed: ${summarizeFailedFiles(failedFiles)}.`,
        );
        openExportIssuesDialog(
          "Export Failed",
          "None of the selected photos could be exported.",
          failedFiles,
        );
        return;
      }

      if (desktopBridge) {
        setExportProgress({
          active: true,
          message: "Writing files...",
          completed: targets.length,
          total: targets.length,
          percent: 100,
        });
        await desktopBridge.exportFiles({
          files: desktopFiles,
          suggestedFolderName: "dj1000-export",
        });
      } else {
        if (browserFiles.length === 1) {
          setExportProgress({
            active: true,
            message: "Preparing download...",
            completed: targets.length,
            total: targets.length,
            percent: 100,
          });
          triggerBrowserDownload(browserFiles[0].blob, getDownloadFileName(browserFiles[0].name));
        } else {
          const archive = await buildBrowserExportArchiveWithProgress(browserFiles, (percent) => {
            setExportProgress({
              active: true,
              message: `Creating ZIP file... ${Math.round(percent)}%`,
              completed: targets.length,
              total: targets.length,
              percent: Math.round(percent),
            });
          });
          triggerBrowserDownload(archive, buildBrowserArchiveName(exportDialog.scope, targets));
        }
      }

      if (failedFiles.length > 0) {
        setStatus(
          `Exported ${formatCount("photo", succeededCount)}. Skipped ${formatCount("failed file", failedFiles.length)}: ${summarizeFailedFiles(failedFiles)}.`,
        );
        openExportIssuesDialog(
          "Export Completed with Skipped Files",
          `Exported ${formatCount("photo", succeededCount)} and skipped ${formatCount("file", failedFiles.length)}.`,
          failedFiles,
        );
      } else {
        setStatus(`Exported ${formatCount("photo", succeededCount)}.`);
      }
    } catch (error) {
      setStatus(`Export failed: ${String(error instanceof Error ? error.message : error)}`);
    } finally {
      setExportProgress({
        active: false,
        message: "",
        completed: 0,
        total: 0,
        percent: 0,
      });
    }
  }

  async function exportSinglePhotoRawDng(photo: PhotoRecord) {
    if (!dngSupported) {
      setStatus("DNG export is unavailable in this build.");
      return;
    }

    setContextMenu(null);
    setStatus(`Preparing ${photo.name} for RAW .DNG export...`);
    setExportProgress({
      active: true,
      message: `Converting ${photo.name}...`,
      completed: 0,
      total: 1,
      percent: 0,
    });

    try {
      const dngBytes = await renderPoolRef.current!.convertDatToDng(photo.datBytes, photo.id);

      if (desktopBridge) {
        setExportProgress({
          active: true,
          message: "Writing file...",
          completed: 1,
          total: 1,
          percent: 100,
        });
        await desktopBridge.exportFiles({
          files: buildDesktopDngExportPayload(photo, dngBytes, false),
          suggestedFolderName: "dj1000-export",
        });
      } else {
        const files = buildBrowserDngExportBundle(photo, dngBytes, false);
        setExportProgress({
          active: true,
          message: "Preparing download...",
          completed: 1,
          total: 1,
          percent: 100,
        });
        triggerBrowserDownload(files[0].blob, getDownloadFileName(files[0].name));
      }

      setStatus(`Exported ${photo.name} as RAW .DNG.`);
    } catch (error) {
      setStatus(`RAW .DNG export failed: ${String(error instanceof Error ? error.message : error)}`);
      openExportIssuesDialog(
        "RAW .DNG Export Failed",
        `The selected photo could not be exported as a RAW .DNG file.`,
        [photo.name],
      );
    } finally {
      setExportProgress({
        active: false,
        message: "",
        completed: 0,
        total: 0,
        percent: 0,
      });
    }
  }

  const platformLabel = isDesktopRuntime() ? "Desktop App" : "Website";
  const currentPreviewZoomPercent = previewZoomMode === "fit" ? fitZoomPercent : previewZoomPercent;
  const zoomSelectValue = previewZoomMode === "fit" ? "fit" : String(previewZoomPercent);
  const browserImportAccept = isMobileLayout ? undefined : ".dat,.DAT,.json";
  const browserDngConvertAccept = isMobileLayout ? undefined : ".dat,.DAT";
  const applyFitZoom = useCallback(() => {
    setPreviewZoomMode("fit");
    setPreviewZoomPercent(fitZoomPercent);
  }, [fitZoomPercent]);

  return (
    <div className="app-shell">
      <input
        ref={fileInputRef}
        type="file"
        hidden
        multiple
        accept={browserImportAccept}
        onChange={(event) => void handleBrowserFileInput("files", event)}
      />
      <input
        ref={folderInputRef}
        type="file"
        hidden
        multiple
        webkitdirectory=""
        accept={browserImportAccept}
        onChange={(event) => void handleBrowserFileInput("folder", event)}
      />
      <input
        ref={dngConvertInputRef}
        type="file"
        hidden
        multiple
        accept={browserDngConvertAccept}
        onChange={(event) => void handleBrowserDngConvertInput(event)}
      />
      <input
        ref={dngConvertFolderInputRef}
        type="file"
        hidden
        multiple
        webkitdirectory=""
        accept={browserDngConvertAccept}
        onChange={(event) => void handleBrowserDngConvertInput(event)}
      />

      <ImportDialog
        state={importDialog}
        desktopAvailable={!!desktopBridge}
        photosLoaded={photos.length > 0}
        onClose={() => setImportDialog((current) => ({ ...current, isOpen: false }))}
        onChangeIngest={(ingestMode) => setImportDialog((current) => ({ ...current, ingestMode }))}
        onChangeLibraryImportMode={(libraryImportMode) => setImportDialog((current) => ({ ...current, libraryImportMode }))}
        onChooseFiles={() => handleImportRun("files")}
        onChooseFolder={() => handleImportRun("folder")}
      />

      <ConvertDatToDngDialog
        isOpen={convertDatDialogOpen}
        includeSourceBundle={rawConverterIncludeSourceBundlePreference}
        onClose={() => setConvertDatDialogOpen(false)}
        onChangeIncludeSourceBundle={updateRawConverterIncludeSourceBundlePreference}
        onChooseFiles={() => handleConvertDatToDngRun("files")}
        onChooseFolder={() => handleConvertDatToDngRun("folder")}
      />

      <ExportDialog
        state={exportDialog}
        desktopAvailable={!!desktopBridge}
        dngSupported={dngSupported}
        currentDisabled={!activePhoto}
        selectedDisabled={selectedPhotos.length === 0}
        allDisabled={photos.length === 0}
        onClose={() => setExportDialog((current) => ({ ...current, isOpen: false }))}
        onChange={handleExportDialogChange}
        onRun={() => void runExport()}
      />

      <ProgressDialog
        title="Processing Export"
        active={exportProgress.active}
        message={exportProgress.message}
        completed={exportProgress.completed}
        total={exportProgress.total}
        percent={exportProgress.percent}
        summary={`${exportProgress.completed} of ${exportProgress.total} photo${exportProgress.total === 1 ? "" : "s"} finished`}
      />

      <ProgressDialog
        title="Loading Example .DAT Files"
        active={exampleImportProgress.active}
        message={exampleImportProgress.message}
        completed={exampleImportProgress.completed}
        total={exampleImportProgress.total}
        percent={exampleImportProgress.percent}
        summary={`${exampleImportProgress.completed} of ${exampleImportProgress.total} step${exampleImportProgress.total === 1 ? "" : "s"} finished`}
      />

      <ExportIssuesDialog
        isOpen={exportIssuesDialog.isOpen}
        title={exportIssuesDialog.title}
        summary={exportIssuesDialog.summary}
        failedFiles={exportIssuesDialog.failedFiles}
        onClose={() => setExportIssuesDialog((current) => ({ ...current, isOpen: false }))}
      />

      <ClearLibraryDialog
        isOpen={clearLibraryDialogOpen && photos.length > 0}
        photoCount={photos.length}
        onCancel={() => setClearLibraryDialogOpen(false)}
        onConfirm={confirmClearCurrentLibrary}
      />

      {contextMenu && contextMenuPhoto ? (
        <PhotoContextMenu
          photo={contextMenuPhoto}
          x={contextMenu.x}
          y={contextMenu.y}
          canPasteEdits={copiedEdits !== null}
          dngSupported={dngSupported}
          onOpenInDevelop={() => {
            setView("develop");
            updateActivePhotoId(contextMenuPhoto.id);
            if (contextMenuPhoto.previewStatus === "idle") {
              queuePreviewRender(contextMenuPhoto);
            }
            setSelectedIds(new Set([contextMenuPhoto.id]));
            setContextMenu(null);
          }}
          onExportRawDng={() => {
            void exportSinglePhotoRawDng(contextMenuPhoto);
          }}
          onSetRating={(rating) => {
            setPhotoRating(contextMenuPhoto.id, rating);
            setContextMenu(null);
          }}
          onTogglePicked={() => {
            togglePhotoReviewStatus(contextMenuPhoto.id, "flagged");
            setContextMenu(null);
          }}
          onToggleRejected={() => {
            togglePhotoReviewStatus(contextMenuPhoto.id, "rejected");
            setContextMenu(null);
          }}
          onToggleRemoved={() => {
            updatePhotoMetadata(contextMenuPhoto.id, { removed: !contextMenuPhoto.metadata.removed });
            setContextMenu(null);
          }}
          onResetEdits={() => {
            resetPhotoEdits(contextMenuPhoto.id);
            setContextMenu(null);
          }}
          onCopyEdits={() => {
            copyPhotoEdits(contextMenuPhoto.id);
            setContextMenu(null);
          }}
          onPasteEdits={() => {
            pastePhotoEdits(contextMenuPhoto.id);
            setContextMenu(null);
          }}
          onRotateLeft={() => {
            rotatePhoto(contextMenuPhoto.id, "left");
            setContextMenu(null);
          }}
          onRotateRight={() => {
            rotatePhoto(contextMenuPhoto.id, "right");
            setContextMenu(null);
          }}
          onFlipHorizontal={() => {
            togglePhotoFlip(contextMenuPhoto.id, "horizontal");
            setContextMenu(null);
          }}
          onFlipVertical={() => {
            togglePhotoFlip(contextMenuPhoto.id, "vertical");
            setContextMenu(null);
          }}
        />
      ) : null}

      <div className="desktop-frame window" style={{height: "100%"}}>
        <div className="title-bar">
          <div className="title-bar-text">Mitsubishi DJ-1000 / UMAX PhotoRun Editor</div>
          <div className="title-bar-controls">
            <button aria-label="Minimize" />
            <button aria-label="Maximize" />
            <button aria-label="Close" />
          </div>
        </div>
        <div ref={shellToolbarRef} className="shell-toolbar">
          <AppMenu
            photosLoaded={photos.length > 0}
            isDevelopMode={view === "develop"}
            canPasteEdits={copiedEdits !== null}
            dngSupported={dngSupported}
            openMenu={openMenu}
            onOpenMenu={setOpenMenu}
            onCloseMenu={() => setOpenMenu(null)}
            onLoadDatFiles={() => openImport()}
            onConvertDatFilesToDng={openConvertDatToDng}
            onClearCurrentLibrary={requestClearCurrentLibrary}
            onExportCurrent={() => openExportDialogForScope("current")}
            onExportSelected={() => openExportDialogForScope("selected")}
            onExportAll={() => openExportDialogForScope("all")}
            onGenerateRawCurrent={() => openExportDialogForScope("current", "dng")}
            onGenerateRawSelected={() => openExportDialogForScope("selected", "dng")}
            onGenerateRawAll={() => openExportDialogForScope("all", "dng")}
            showRemoved={showRemoved}
            onToggleShowRemoved={() => setShowRemoved((current) => !current)}
            onSelectAll={() => setSelectedIds(new Set(visiblePhotos.map((photo) => photo.id)))}
            onClearSelection={() => setSelectedIds(new Set())}
            onResetCurrent={resetCurrentPhoto}
            onCopyCurrentEdits={() => activePhoto && copyPhotoEdits(activePhoto.id)}
            onPasteCurrentEdits={() => activePhoto && pastePhotoEdits(activePhoto.id)}
            onRotateCurrentLeft={() => activePhoto && rotatePhoto(activePhoto.id, "left")}
            onRotateCurrentRight={() => activePhoto && rotatePhoto(activePhoto.id, "right")}
            onFlipCurrentHorizontal={() => activePhoto && togglePhotoFlip(activePhoto.id, "horizontal")}
            onFlipCurrentVertical={() => activePhoto && togglePhotoFlip(activePhoto.id, "vertical")}
            onShowLibrary={() => setView("library")}
            onShowDevelop={() => setView("develop")}
            minimumRating={minimumRating}
            onSetMinimumRating={setMinimumRating}
            reviewFilter={reviewFilter}
            onSetReviewFilter={setReviewFilter}
          />

          <div className="menu-strip toolbar-action-menu">
            <div ref={importConvertMenuAnchorRef} className="menu-anchor">
              <button onClick={() => setOpenMenu(openMenu === "import-convert" ? null : "import-convert")}>
                Import / Convert
              </button>
              {openMenu === "import-convert" && (
                <div className={`window menu-dropdown${toolbarMenuAlignment.importConvert ? " menu-dropdown-align-right" : ""}`}>
                  <div className="window-body context-menu-body">
                    <button
                      className="context-menu-item"
                      onClick={() => {
                        setOpenMenu(null);
                        openImport();
                      }}
                    >
                      Import .DAT Files into Library
                    </button>
                    {dngSupported ? (
                      <>
                        <div className="context-menu-separator" />
                        <button
                          className="context-menu-item"
                          onClick={() => {
                            setOpenMenu(null);
                            openConvertDatToDng();
                          }}
                        >
                          Generate RAW Files from .DATs
                        </button>
                        <div className="context-menu-separator" />
                        <button
                          className="context-menu-item"
                          disabled={!activePhoto}
                          onClick={() => {
                            setOpenMenu(null);
                            openExportDialogForScope("current", "dng");
                          }}
                        >
                          Generate RAW from Current
                        </button>
                        <button
                          className="context-menu-item"
                          disabled={selectedPhotos.length === 0}
                          onClick={() => {
                            setOpenMenu(null);
                            openExportDialogForScope("selected", "dng");
                          }}
                        >
                          Generate RAW(s) from Selected
                        </button>
                        <button
                          className="context-menu-item"
                          disabled={photos.length === 0}
                          onClick={() => {
                            setOpenMenu(null);
                            openExportDialogForScope("all", "dng");
                          }}
                        >
                          Generate RAWs for Entire Library
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
            <div ref={exportMenuAnchorRef} className="menu-anchor">
              <button disabled={photos.length === 0} onClick={() => setOpenMenu(openMenu === "export" ? null : "export")}>
                Export
              </button>
              {openMenu === "export" && (
                <div className={`window menu-dropdown${toolbarMenuAlignment.export ? " menu-dropdown-align-right" : ""}`}>
                  <div className="window-body context-menu-body">
                    <button
                      className="context-menu-item"
                      disabled={!activePhoto}
                      onClick={() => {
                        setOpenMenu(null);
                        openExportDialogForScope("current");
                      }}
                    >
                      Export Current
                    </button>
                    <button
                      className="context-menu-item"
                      disabled={selectedPhotos.length === 0}
                      onClick={() => {
                        setOpenMenu(null);
                        openExportDialogForScope("selected");
                      }}
                    >
                      Export Selected
                    </button>
                    <button
                      className="context-menu-item"
                      disabled={photos.length === 0}
                      onClick={() => {
                        setOpenMenu(null);
                        openExportDialogForScope("all");
                      }}
                    >
                      Export All
                    </button>
                    {dngSupported ? (
                      <>
                        <div className="context-menu-separator" />
                        <button
                          className="context-menu-item"
                          disabled={!activePhoto}
                          onClick={() => {
                            setOpenMenu(null);
                            openExportDialogForScope("current", "dng");
                          }}
                        >
                          Generate RAW from Current
                        </button>
                        <button
                          className="context-menu-item"
                          disabled={selectedPhotos.length === 0}
                          onClick={() => {
                            setOpenMenu(null);
                            openExportDialogForScope("selected", "dng");
                          }}
                        >
                          Generate RAW(s) from Selected
                        </button>
                        <button
                          className="context-menu-item"
                          disabled={photos.length === 0}
                          onClick={() => {
                            setOpenMenu(null);
                            openExportDialogForScope("all", "dng");
                          }}
                        >
                          Generate RAWs for Entire Library
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="shell-toolbar-spacer" />
          <div className="button-row toolbar-view-buttons">
            <button disabled={photos.length === 0} onClick={() => setView("library")}>
              Library
            </button>
            <button disabled={!activePhoto} onClick={() => setView("develop")}>
              Develop
            </button>
          </div>
        </div>

        <div className="workspace-grid status-bar-field" style={{backgroundColor: "#808080", gap: "8px", padding: "8px"}}>
          <section className="window window-fill navigator-window">
            <div className="title-bar">
              <div className="title-bar-text">Project Navigator</div>
              <div className="title-bar-controls">
                <button aria-label="Help" />
              </div>
            </div>
            <div className="window-body window-body-fill">
              <div className="field-column">
                <button onClick={() => openImport()}>Import .DAT Files into Library</button>
                {dngSupported ? <button onClick={openConvertDatToDng}>Generate RAW Files from .DATs</button> : null}
                {shouldShowExampleButton ? (
                  <button onClick={() => void loadExamplePhotos()} disabled={exampleImportProgress.active}>
                    Open Example .DAT Files
                  </button>
                ) : null}
                {!desktopBridge ? (
                  <p className="field-help compact-help">Your photos stay on this device. Nothing is uploaded.</p>
                ) : null}
                {activePhoto ? (
                <div className="status-bar-field">
                  
                  <div className="window-body sidebar-scroll field-column">
                    <strong>{activePhoto.name}</strong>
                    <span className="surface-muted">{activePhoto.relativePath}</span>
                    <span>Status: {activePhoto.previewStatus}</span>
                    

                    <fieldset className="group-box inspector-section field-column">
                      <legend>Review</legend>
                      <div className="field-row-stacked">
                        <span className="inspector-section-label">Rating</span>
                        <RatingStars rating={activePhoto.metadata.rating} onSetRating={(rating) => setPhotoRating(activePhoto.id, rating)} />
                      </div>

                      <div className="field-row-stacked">
                        <span className="inspector-section-label">Pick / Reject</span>
                        <div className="review-action-row">
                          <ReviewActionButton
                            label="Pick"
                            kind="pick"
                            active={activePhoto.metadata.reviewStatus === "flagged"}
                            onClick={() => togglePhotoReviewStatus(activePhoto.id, "flagged")}
                          />
                          <ReviewActionButton
                            label="Reject"
                            kind="reject"
                            active={activePhoto.metadata.reviewStatus === "rejected"}
                            onClick={() => togglePhotoReviewStatus(activePhoto.id, "rejected")}
                          />
                        </div>
                      </div>

                      <button onClick={() => updatePhotoMetadata(activePhoto.id, { removed: !activePhoto.metadata.removed })}>
                        {activePhoto.metadata.removed ? "Restore To Library" : "Remove From Library"}
                      </button>
                    </fieldset>

                    <fieldset className="group-box inspector-summary">
                      <legend>Current Adjustments</legend>
                      <div className="inspector-summary">
                        <span>Working size: {activePhoto.edits.size}</span>
                        <span>Orientation: {describeOrientation(activePhoto.edits)}</span>
                        <span>
                          Tone: {activePhoto.edits.contrast}/{activePhoto.edits.brightness}/{activePhoto.edits.vividness}/{activePhoto.edits.sharpness}
                        </span>
                        <span>
                          Color: {activePhoto.edits.redBalance}/{activePhoto.edits.greenBalance}/{activePhoto.edits.blueBalance}
                        </span>
                      </div>
                    </fieldset>
                  </div>
                </div>
              ) : (
                <div className="status-bar-field">
                  <div className="window-body sidebar-scroll field-column">
                  <strong>No photo selected yet</strong>
                 
                  <span>Select a thumbnail in the library to jump into the develop view.</span>
                  </div>
                </div>
              )}
                <div className="status-bar-field">
                  <div className="window-body sidebar-scroll field-column">
                <strong>Library Filtering</strong>
                <div className="field-row-stacked">
                  <label htmlFor="minimum-rating">Minimum rating</label>
                  <select
                    id="minimum-rating"
                    value={minimumRating}
                    onChange={(event) => setMinimumRating(Number(event.target.value))}
                  >
                    <option value={0}>Any rating</option>
                    <option value={1}>1 star or more</option>
                    <option value={2}>2 stars or more</option>
                    <option value={3}>3 stars or more</option>
                    <option value={4}>4 stars or more</option>
                    <option value={5}>5 stars only</option>
                  </select>
                </div>
                <div className="field-row-stacked">
                  <label htmlFor="review-filter">Pick filter</label>
                  <select
                    id="review-filter"
                    value={reviewFilter}
                    onChange={(event) => setReviewFilter(event.target.value as ReviewFilter)}
                  >
                    <option value="all">All photos</option>
                    <option value="picked">Picked only</option>
                    <option value="rejected">Rejected only</option>
                    <option value="not-rejected">Hide rejected</option>
                  </select>
                  
                </div>
                <div className="status-bar">
                <p className="status-bar-field">{formatCount("photo", libraryStats.total)}</p>
                <p className="status-bar-field">{formatCount("picked", libraryStats.picked)}</p>
                <p className="status-bar-field">{formatCount("rejected", libraryStats.rejected)}</p>
              </div>
                </div>
                </div>
              </div>

              

              
            </div>
          </section>

          {view === "library" ? (
            <section className="window window-fill">
              <div className="title-bar">
                <div className="title-bar-text">Library Grid</div>
                <div className="title-bar-controls">
                  <button aria-label="Minimize" />
                  <button aria-label="Restore" />
                  <button aria-label="Close" />
                </div>
              </div>
              <div className="window-body window-body-fill">
                {visiblePhotos.length === 0 ? (
                  <div className="placeholder-copy sunken-panel">
                    {photos.length === 0 ? (
                      <>
                        <span>
                          Import .DAT files into the library to be viewed and edited using image processing algorithms faithful to the original conversion software.
                        </span>
                        <span><strong>Or...</strong></span>
                        <span>
                          Generate RAW .DNG images from .DAT files to be edited in third-party software using modern image processing for improved dynamic range, exposure latitude, and cleaner details.
                        </span>
                        <div className="empty-state-actions">
                          <button onClick={() => openImport()}>Import .DAT Files into Library</button>
                          {dngSupported ? <button onClick={openConvertDatToDng}>Generate RAW Files from .DATs</button> : null}
                        </div>
                        {!desktopBridge ? <p className="field-help compact-help empty-state-privacy-note">Your photos stay on this device. Nothing is uploaded.</p> : null}
                        {shouldShowExampleButton ? (
                          <>
                            <p className="field-help compact-help empty-state-example-note">No .DAT files of your own? Experiment with provided examples.</p>
                            <button onClick={() => void loadExamplePhotos()} disabled={exampleImportProgress.active}>
                              View and Edit Example .DAT Files
                            </button>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <strong>No visible photos right now</strong>
                        <span>Everything is currently removed from the library. Turn on “Show removed photos” to bring them back into view.</span>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="window-body-fill">
                    <div className="button-row">
                      <button onClick={() => setView("develop")} disabled={!activePhoto}>
                        Open In Develop
                      </button>
                      <button onClick={() => openExportDialogForScope("selected")}>
                        Export Selected
                      </button>
                      <button onClick={requestClearCurrentLibrary}>
                        Clear Current Library
                      </button>
                    </div>
                    <div className="library-scroll sunken-panel" style={{ padding: 10 }}>
                      <div className="library-grid">
                        {visiblePhotos.map((photo) => (
                          <button
                            key={photo.id}
                            className={`thumbnail-card ${selectedIds.has(photo.id) ? "is-selected" : ""} ${
                              activePhotoId === photo.id ? "is-active" : ""
                            } ${photo.metadata.removed ? "is-removed" : ""}`}
                            onClick={(event) => handleSelectPhoto(photo.id, event)}
                            onContextMenu={(event) => handleOpenPhotoContextMenu(photo.id, event)}
                            onDoubleClick={() => {
                              lastLibraryTapRef.current = null;
                              setView("develop");
                              updateActivePhotoId(photo.id);
                              if (photo.previewStatus === "idle") {
                                queuePreviewRender(photo);
                              }
                              setSelectedIds(new Set([photo.id]));
                            }}
                          >
                            <div className="thumbnail-figure">
                              {photo.thumbnailUrl ? <img src={photo.thumbnailUrl} alt={photo.name} /> : <span>{photo.thumbnailStatus}</span>}
                            </div>
                            <div className="thumbnail-meta">
                              <span className="thumbnail-name">{photo.name}</span>
                              <PhotoReviewSummary metadata={photo.metadata} className="thumbnail-flags" />
                              <span className="thumbnail-path">{photo.relativePath}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <div className="workspace-stack">
              <section className="window window-fill">
                <div className="title-bar">
                  <div className="title-bar-text">{`Develop Module${activePhoto ? ` — ${activePhoto.name}` : ""}`}</div>
                  <div className="title-bar-controls">
                    <button aria-label="Minimize" />
                    <button aria-label="Restore" />
                    <button aria-label="Close" />
                  </div>
                </div>
                <div className="window-body window-body-fill">
                  {visiblePhotos.length === 0 ? (
                    <div className="placeholder-copy sunken-panel">
                      {photos.length === 0 ? (
                        <>
                          <span>
                            Import .DAT files into the library to be viewed and edited using image processing algorithms faithful to the original conversion software.
                          </span>
                          <span><strong>Or...</strong></span>
                          <span>
                            Generate RAW .DNG images from .DAT files to be edited in third-party software using modern image processing for improved dynamic range, exposure latitude, and cleaner details.
                          </span>
                          <div className="empty-state-actions">
                            <button onClick={() => openImport()}>Import .DAT Files into Library</button>
                            {dngSupported ? <button onClick={openConvertDatToDng}>Generate RAW Files from .DATs</button> : null}
                          </div>
                          {!desktopBridge ? <p className="field-help compact-help empty-state-privacy-note">Your photos stay on this device. Nothing is uploaded.</p> : null}
                          {shouldShowExampleButton ? (
                            <>
                              <p className="field-help compact-help empty-state-example-note">No .DAT files of your own? Experiment with provided examples.</p>
                              <button onClick={() => void loadExamplePhotos()} disabled={exampleImportProgress.active}>
                                View and Edit Example .DAT Files
                              </button>
                            </>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <strong>No visible photos right now</strong>
                          <span>Everything is currently removed from the library. Turn on “Show removed photos” to bring them back into view.</span>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="develop-layout">
                      <div className="preview-panel">
                        <div className={`sunken-panel preview-stage ${previewZoomMode === "fit" ? "is-fit-mode" : ""}`.trim()}>
                          {activePhoto ? (
                            <PhotoCanvas
                              frame={activePhoto.preview}
                              edits={activePhoto.edits}
                              zoomPercent={currentPreviewZoomPercent}
                              onFitZoomChange={setFitZoomPercent}
                            />
                          ) : (
                            <span>No active photo</span>
                          )}
                        </div>
                        <div className="status-bar">
                          <p className="status-bar-field">{activePhoto?.name ?? "No file"}</p>
                          <p className="status-bar-field">
                            {activePhoto?.preview ? `${activePhoto.preview.width} × ${activePhoto.preview.height}` : "Preview pending"}
                          </p>
                          <p className="status-bar-field">{activePhoto?.previewStatus ?? "idle"}</p>
                          <p className="status-bar-field">{`Zoom ${Math.round(currentPreviewZoomPercent)}%`}</p>
                        </div>
                      </div>

                      <div className="status-bar-field window window-fill">
                        <div className="window-body sidebar-scroll inspector-stack">
                          <strong>Develop Controls</strong>
                          {activePhoto ? (
                            <>
                              <div className="field-row-stacked develop-group-working-size">
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

                              <fieldset className="group-box field-column develop-group-view">
                                <legend>View</legend>
                                <div className="button-row preview-zoom-controls">
                                  <button
                                    className={previewZoomMode === "custom" && previewZoomPercent === 100 ? "is-active" : ""}
                                    onClick={() => {
                                      setPreviewZoomMode("custom");
                                      setPreviewZoomPercent(100);
                                    }}
                                  >
                                    Actual Size
                                  </button>
                                  <button className={previewZoomMode === "fit" ? "is-active" : ""} onClick={applyFitZoom}>
                                    Fit
                                  </button>
                                  <label className="field-row preview-zoom-readout">
                                    <span>Zoom:</span>
                                    <select
                                      aria-label="Zoom percentage"
                                      value={zoomSelectValue}
                                      onChange={(event) => {
                                        if (event.target.value === "fit") {
                                          applyFitZoom();
                                          return;
                                        }

                                        setPreviewZoomMode("custom");
                                        setPreviewZoomPercent(Number(event.target.value));
                                      }}
                                    >
                                      <option value="fit">Fit</option>
                                      {zoomPercentOptions.map((value) => (
                                        <option key={value} value={value}>
                                          {value}%
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                </div>
                              </fieldset>

                              <fieldset className="group-box field-column develop-group-orientation">
                                <legend>Orientation</legend>
                                <div className="field-column">
                                  <div className="icon-action-row">
                                    <IconActionButton
                                      label="Rotate Left"
                                      icon="⟲"
                                      showLabel={false}
                                      largeIcon
                                      onClick={() => rotatePhoto(activePhoto.id, "left")}
                                    />
                                    <IconActionButton
                                      label="Rotate Right"
                                      icon="⟳"
                                      showLabel={false}
                                      largeIcon
                                      onClick={() => rotatePhoto(activePhoto.id, "right")}
                                    />
                                    <IconActionButton
                                      label="Flip Horizontal"
                                      icon="⇋"
                                      active={activePhoto.edits.flipHorizontal}
                                      showLabel={false}
                                      onClick={() => togglePhotoFlip(activePhoto.id, "horizontal")}
                                    />
                                    <IconActionButton
                                      label="Flip Vertical"
                                      icon="⇵"
                                      active={activePhoto.edits.flipVertical}
                                      showLabel={false}
                                      onClick={() => togglePhotoFlip(activePhoto.id, "vertical")}
                                    />
                                  </div>
                                </div>
                              </fieldset>

                              <fieldset className="group-box inspector-section field-column develop-group-review">
                                <legend>Review</legend>
                                <div className="field-row-stacked">
                                  <span className="inspector-section-label">Rating</span>
                                  <RatingStars rating={activePhoto.metadata.rating} onSetRating={(rating) => setPhotoRating(activePhoto.id, rating)} />
                                </div>

                                <div className="field-row-stacked">
                                  <span className="inspector-section-label">Pick / Reject</span>
                                  <div className="review-action-row">
                                    <ReviewActionButton
                                      label="Pick"
                                      kind="pick"
                                      active={activePhoto.metadata.reviewStatus === "flagged"}
                                      onClick={() => togglePhotoReviewStatus(activePhoto.id, "flagged")}
                                    />
                                    <ReviewActionButton
                                      label="Reject"
                                      kind="reject"
                                      active={activePhoto.metadata.reviewStatus === "rejected"}
                                      onClick={() => togglePhotoReviewStatus(activePhoto.id, "rejected")}
                                    />
                                  </div>
                                </div>
                              </fieldset>

                              <fieldset className="group-box field-column develop-group-tone">
                                <legend>Tone</legend>
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
                              </fieldset>

                              <fieldset className="group-box field-column develop-group-color">
                                <legend>Color Balance</legend>
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
                              </fieldset>

                              <div className="field-column current-photo-actions develop-group-actions">
                                <div className="button-row">
                                  <button onClick={() => copyPhotoEdits(activePhoto.id)}>Copy Edits</button>
                                  <button disabled={!copiedEdits} onClick={() => pastePhotoEdits(activePhoto.id)}>
                                    Paste Edits
                                  </button>
                                  <button onClick={resetCurrentPhoto}>Reset Photo</button>
                                </div>
                              </div>
                            </>
                          ) : (
                            <div className="placeholder-copy">Choose a photo to edit.</div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {visiblePhotos.length > 0 && (!isMobileLayout || visiblePhotos.length > 1) ? (
                <section className="window filmstrip-window">
                  <div className="title-bar">
                    <div className="title-bar-text">Film Strip</div>
                    <div className="title-bar-controls">
                      <button aria-label="Close" />
                    </div>
                  </div>
                  <div className="window-body">
                    <div className="filmstrip-viewport">
                      <div className="filmstrip-scroll">
                        <div className="filmstrip">
                          {visiblePhotos.map((photo) => (
                            <button
                              key={photo.id}
                              className={`filmstrip-button ${photo.id === activePhotoId ? "is-active" : ""} ${
                                photo.metadata.removed ? "is-removed" : ""
                              }`}
                              onClick={() => {
                                updateActivePhotoId(photo.id);
                                if (photo.previewStatus === "idle") {
                                  queuePreviewRender(photo);
                                }
                                setSelectedIds(new Set([photo.id]));
                              }}
                              onContextMenu={(event) => handleOpenPhotoContextMenu(photo.id, event)}
                            >
                              <div className="filmstrip-thumb">
                                {photo.thumbnailUrl ? <img src={photo.thumbnailUrl} alt={photo.name} /> : <span>{photo.thumbnailStatus}</span>}
                              </div>
                              <span className="filmstrip-label">{photo.name}</span>
                              <PhotoReviewSummary metadata={photo.metadata} className="filmstrip-meta" />
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              ) : null}
            </div>
          )}
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
