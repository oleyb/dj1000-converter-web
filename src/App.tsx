import {
  startTransition,
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
  buildDesktopExportPayload,
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
  PhotoEdits,
  PhotoMetadata,
  PhotoRecord,
  PhotoReviewStatus,
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

function comparePhotoNames(left: PhotoRecord, right: PhotoRecord) {
  return left.name.localeCompare(right.name, undefined, {
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
  zoomMode,
  zoomPercent,
  onFitZoomChange,
}: {
  frame?: RenderedFrame;
  edits?: PhotoEdits;
  zoomMode: "fit" | "custom";
  zoomPercent: number;
  onFitZoomChange: (zoomPercent: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const outputSize = frame && edits ? getTransformedFrameSize(frame, edits) : { width: 504, height: 378 };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame || !edits) {
      return;
    }

    drawFrameToCanvas(canvas, frame, edits);
  }, [edits, frame]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !frame || !edits) {
      return;
    }

    const updateFitZoom = () => {
      const width = Math.max(1, viewport.clientWidth - fitViewportSafetyMarginPx);
      const height = Math.max(1, viewport.clientHeight - fitViewportSafetyMarginPx);
      const scale = Math.min(width / outputSize.width, height / outputSize.height);
      const nextZoom = Math.max(5, scale * 100);
      onFitZoomChange(nextZoom);
    };

    updateFitZoom();
    const observer = new ResizeObserver(updateFitZoom);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [edits, frame, onFitZoomChange, outputSize.height, outputSize.width]);

  const effectiveZoomPercent = zoomMode === "fit" ? zoomPercent : zoomPercent;
  const canvasStyle = {
    width: `${Math.max(1, Math.floor((outputSize.width * effectiveZoomPercent) / 100))}px`,
    height: `${Math.max(1, Math.floor((outputSize.height * effectiveZoomPercent) / 100))}px`,
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
  openMenu,
  onOpenMenu,
  onCloseMenu,
  onImportFiles,
  onImportFolder,
  onExportCurrent,
  onExportSelected,
  onExportAll,
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
}: {
  photosLoaded: boolean;
  isDevelopMode: boolean;
  canPasteEdits: boolean;
  openMenu: string | null;
  onOpenMenu: (menu: string | null) => void;
  onCloseMenu: () => void;
  onImportFiles: () => void;
  onImportFolder: () => void;
  onExportCurrent: () => void;
  onExportSelected: () => void;
  onExportAll: () => void;
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
}) {
  return (
    <div className="menu-strip" onMouseLeave={onCloseMenu}>
      <div className="menu-anchor">
        <button className="menu-button" onClick={() => onOpenMenu(openMenu === "file" ? null : "file")}>
          File
        </button>
        {openMenu === "file" && (
          <div className="window menu-dropdown">
            <div className="window-body context-menu-body">
              <button className="context-menu-item" onClick={onImportFiles}>
                Open Files…
              </button>
              <button className="context-menu-item" onClick={onImportFolder}>
                Open Folder…
              </button>
              <div className="context-menu-separator" />
              <button className="context-menu-item" disabled={!photosLoaded || !isDevelopMode} onClick={onExportCurrent}>
                Export Current
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={onExportSelected}>
                Export Selected
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={onExportAll}>
                Export All
              </button>
              <div className="context-menu-separator" />
              <button className="context-menu-item" onClick={onToggleShowRemoved}>
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
              <button className="context-menu-item" disabled={!photosLoaded} onClick={onSelectAll}>
                Select All
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={onClearSelection}>
                Clear Selection
              </button>
              <div className="context-menu-separator" />
              <button className="context-menu-item" disabled={!isDevelopMode} onClick={onCopyCurrentEdits}>
                Copy Edits
              </button>
              <button className="context-menu-item" disabled={!isDevelopMode || !canPasteEdits} onClick={onPasteCurrentEdits}>
                Paste Edits
              </button>
              <button className="context-menu-item" disabled={!isDevelopMode} onClick={onResetCurrent}>
                Reset Current Photo
              </button>
              <div className="context-menu-separator" />
              <button className="context-menu-item" disabled={!isDevelopMode} onClick={onRotateCurrentLeft}>
                Rotate Left
              </button>
              <button className="context-menu-item" disabled={!isDevelopMode} onClick={onRotateCurrentRight}>
                Rotate Right
              </button>
              <button className="context-menu-item" disabled={!isDevelopMode} onClick={onFlipCurrentHorizontal}>
                Flip Horizontal
              </button>
              <button className="context-menu-item" disabled={!isDevelopMode} onClick={onFlipCurrentVertical}>
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
              <button className="context-menu-item" onClick={onShowLibrary}>
                Library
              </button>
              <button className="context-menu-item" disabled={!photosLoaded} onClick={onShowDevelop}>
                Develop
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

function ExportProgressDialog({
  active,
  message,
  completed,
  total,
  percent,
}: {
  active: boolean;
  message: string;
  completed: number;
  total: number;
  percent: number;
}) {
  if (!active) {
    return null;
  }

  return (
    <div className="dialog-backdrop">
      <div className="window progress-window">
        <div className="title-bar">
          <div className="title-bar-text">Processing Export</div>
          <div className="title-bar-controls">
            <button aria-label="Busy" disabled />
          </div>
        </div>
        <div className="window-body field-column">
          <p>{message}</p>
          <div className="sunken-panel progress-meter">
            <div className="progress-meter-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="field-help">
            {completed} of {total} photo{total === 1 ? "" : "s"} finished
          </p>
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
  onOpenInDevelop,
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
  onOpenInDevelop: () => void;
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
  });
  const [exportDialog, setExportDialog] = useState<ExportDialogState>({
    isOpen: false,
    scope: "current",
    format: "png",
    includeSourceBundle: false,
  });
  const [exportProgress, setExportProgress] = useState({
    active: false,
    message: "",
    completed: 0,
    total: 0,
    percent: 0,
  });
  const [previewZoomMode, setPreviewZoomMode] = useState<"fit" | "custom">("fit");
  const [previewZoomPercent, setPreviewZoomPercent] = useState(100);
  const [fitZoomPercent, setFitZoomPercent] = useState(100);

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
    setActivePhotoId(nextActive?.id ?? null);

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
  }, [activePhoto, activePhotoId, visiblePhotoIds, visiblePhotos]);

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
      rotation: 0,
      flipHorizontal: false,
      flipVertical: false,
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

  async function hydrateImportedPhotos(
    payloads: ReturnType<typeof createPhotoRecord>[],
    preferredActiveId?: string | null,
  ) {
    const pool = renderPoolRef.current;
    if (!pool || payloads.length === 0) {
      return;
    }

    setStatus(`Opening ${formatCount("photo", payloads.length)}...`);
    for (const payload of payloads) {
      try {
        await pool.openDocument(payload.id, payload.datBytes);
        if (preferredActiveId && payload.id === preferredActiveId) {
          setActivePhotoId(preferredActiveId);
        }
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

    const preferredActiveId = !activePhotoId ? [...payloads].sort(comparePhotoNames)[0].id : null;

    startTransition(() => {
      setPhotos((current) => [...current, ...payloads]);
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const photo of payloads) {
          next.add(photo.id);
        }
        return next;
      });
    });

    await hydrateImportedPhotos(payloads, preferredActiveId);
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
        sidecarText: stringifySidecar(photo.edits, photo.metadata),
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

  function handleOpenPhotoContextMenu(photoId: string, event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setOpenMenu(null);
    setActivePhotoId(photoId);
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
      for (const [index, photo] of targets.entries()) {
        setExportProgress({
          active: true,
          message: `Preparing ${photo.name} (${index + 1} of ${targets.length})...`,
          completed: index,
          total: targets.length,
          percent: Math.round((index / Math.max(targets.length, 1)) * 100),
        });

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

      setStatus(`Exported ${formatCount("photo", targets.length)}.`);
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

  const platformLabel = isDesktopRuntime() ? "Desktop App" : "Website";
  const currentPreviewZoomPercent = previewZoomMode === "fit" ? fitZoomPercent : previewZoomPercent;
  const zoomSelectValue = previewZoomMode === "fit" ? "fit" : String(previewZoomPercent);
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

      <ExportProgressDialog
        active={exportProgress.active}
        message={exportProgress.message}
        completed={exportProgress.completed}
        total={exportProgress.total}
        percent={exportProgress.percent}
      />

      {contextMenu && contextMenuPhoto ? (
        <PhotoContextMenu
          photo={contextMenuPhoto}
          x={contextMenu.x}
          y={contextMenu.y}
          canPasteEdits={copiedEdits !== null}
          onOpenInDevelop={() => {
            setView("develop");
            setActivePhotoId(contextMenuPhoto.id);
            setSelectedIds(new Set([contextMenuPhoto.id]));
            setContextMenu(null);
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
        <div className="shell-toolbar">
          <AppMenu
            photosLoaded={photos.length > 0}
            isDevelopMode={view === "develop"}
            canPasteEdits={copiedEdits !== null}
            openMenu={openMenu}
            onOpenMenu={setOpenMenu}
            onCloseMenu={() => setOpenMenu(null)}
            onImportFiles={() => openImport("files")}
            onImportFolder={() => openImport("folder")}
            onExportCurrent={() => setExportDialog((current) => ({ ...current, isOpen: true, scope: "current" }))}
            onExportSelected={() => setExportDialog((current) => ({ ...current, isOpen: true, scope: "selected" }))}
            onExportAll={() => setExportDialog((current) => ({ ...current, isOpen: true, scope: "all" }))}
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
          />

          <div className="menu-strip toolbar-action-menu" onMouseLeave={() => openMenu === "export" && setOpenMenu(null)}>
            <button onClick={() => openImport("files")}>Import</button>
            <div className="menu-anchor">
              <button disabled={photos.length === 0} onClick={() => setOpenMenu(openMenu === "export" ? null : "export")}>
                Export
              </button>
              {openMenu === "export" && (
                <div className="window menu-dropdown">
                  <div className="window-body context-menu-body">
                    <button
                      className="context-menu-item"
                      disabled={!activePhoto}
                      onClick={() => setExportDialog((current) => ({ ...current, isOpen: true, scope: "current" }))}
                    >
                      Export Current
                    </button>
                    <button
                      className="context-menu-item"
                      disabled={selectedPhotos.length === 0}
                      onClick={() => setExportDialog((current) => ({ ...current, isOpen: true, scope: "selected" }))}
                    >
                      Export Selected
                    </button>
                    <button
                      className="context-menu-item"
                      disabled={photos.length === 0}
                      onClick={() => setExportDialog((current) => ({ ...current, isOpen: true, scope: "all" }))}
                    >
                      Export All
                    </button>
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
                      <button onClick={() => setExportDialog((current) => ({ ...current, isOpen: true, scope: "selected" }))}>
                        Export Selected
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
                        <div className="sunken-panel preview-stage">
                          {activePhoto ? (
                            <PhotoCanvas
                              frame={activePhoto.preview}
                              edits={activePhoto.edits}
                              zoomMode={previewZoomMode}
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

                              <fieldset className="group-box field-column">
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

                              <fieldset className="group-box field-column">
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

                              <fieldset className="group-box field-column">
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

                              <fieldset className="group-box field-column">
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

                              <div className="field-column current-photo-actions">
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

              {visiblePhotos.length > 0 ? (
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
                                setActivePhotoId(photo.id);
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
