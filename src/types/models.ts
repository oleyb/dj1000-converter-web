export type LibraryView = "library" | "develop";
export type ImportKind = "files" | "folder";
export type IngestMode = "in-place" | "copy";
export type LibraryImportMode = "add" | "replace";
export type ExportScope = "current" | "selected" | "all";
export type ExportFormat = "png" | "jpeg" | "dng";
export type RenderIntent = "thumbnail" | "preview" | "export";
export type RenderSize = "small" | "normal" | "large";
export type PhotoReviewStatus = "none" | "flagged" | "rejected";
export type PhotoRotation = 0 | 90 | 180 | 270;

export interface LegacyPipelineEdits {
  size: RenderSize;
  redBalance: number;
  greenBalance: number;
  blueBalance: number;
  contrast: number;
  brightness: number;
  vividness: number;
  sharpness: number;
}

export interface ViewEdits {
  rotation: PhotoRotation;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

export interface PhotoEdits {
  size: LegacyPipelineEdits["size"];
  redBalance: LegacyPipelineEdits["redBalance"];
  greenBalance: LegacyPipelineEdits["greenBalance"];
  blueBalance: LegacyPipelineEdits["blueBalance"];
  contrast: LegacyPipelineEdits["contrast"];
  brightness: LegacyPipelineEdits["brightness"];
  vividness: LegacyPipelineEdits["vividness"];
  sharpness: LegacyPipelineEdits["sharpness"];
  rotation: ViewEdits["rotation"];
  flipHorizontal: ViewEdits["flipHorizontal"];
  flipVertical: ViewEdits["flipVertical"];
}

export interface PhotoMetadata {
  rating: number;
  reviewStatus: PhotoReviewStatus;
  removed: boolean;
}

export interface PhotoPipelineEntry {
  version: number;
  settings: Record<string, unknown>;
}

export interface PhotoSidecar {
  schema: "dj1000-photo-settings/v3";
  activePipeline: string;
  pipelines: Record<string, PhotoPipelineEntry>;
  presentation: ViewEdits;
  metadata: PhotoMetadata;
  updatedAt: string;
}

export interface RenderedFrame {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface PhotoRecord {
  id: string;
  name: string;
  relativePath: string;
  importedAt: number;
  filePath?: string;
  sidecarPath?: string | null;
  ingestMode: IngestMode;
  datBytes: Uint8Array;
  edits: PhotoEdits;
  metadata: PhotoMetadata;
  sidecar: PhotoSidecar | null;
  thumbnail?: RenderedFrame;
  thumbnailUrl?: string;
  preview?: RenderedFrame;
  previewStatus: "idle" | "loading" | "ready" | "error";
  thumbnailStatus: "idle" | "loading" | "ready" | "error";
  error?: string;
}

export interface ImportRequest {
  kind: ImportKind;
  ingestMode: IngestMode;
}

export interface ImportDialogState {
  kind: ImportKind;
  ingestMode: IngestMode;
  libraryImportMode: LibraryImportMode;
  isOpen: boolean;
}

export interface ExportDialogState {
  isOpen: boolean;
  scope: ExportScope;
  format: ExportFormat;
  includeSourceBundle: boolean;
}

export interface ImportedPhotoPayload {
  name: string;
  relativePath: string;
  importedAt?: number;
  filePath?: string;
  sidecarPath?: string | null;
  ingestMode: IngestMode;
  bytes: Uint8Array;
  sidecarText?: string | null;
}

export interface ExportFilePayload {
  relativePath: string;
  bytes: ArrayBuffer;
}

export const defaultEdits = (): PhotoEdits => ({
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

export const defaultMetadata = (): PhotoMetadata => ({
  rating: 0,
  reviewStatus: "none",
  removed: false,
});
