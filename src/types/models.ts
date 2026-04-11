export type LibraryView = "library" | "develop";
export type ImportKind = "files" | "folder";
export type IngestMode = "in-place" | "copy";
export type ExportScope = "current" | "selected" | "all";
export type ExportFormat = "png" | "jpeg";
export type RenderIntent = "thumbnail" | "preview" | "export";
export type RenderSize = "small" | "normal" | "large";

export interface PhotoEdits {
  size: RenderSize;
  redBalance: number;
  greenBalance: number;
  blueBalance: number;
  contrast: number;
  brightness: number;
  vividness: number;
  sharpness: number;
}

export interface PhotoSidecar {
  schema: "dj1000-photo-settings/v1";
  edits: PhotoEdits;
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
  filePath?: string;
  sidecarPath?: string | null;
  ingestMode: IngestMode;
  datBytes: Uint8Array;
  edits: PhotoEdits;
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
});
