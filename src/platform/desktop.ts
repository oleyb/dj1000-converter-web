import type { ExportFilePayload, ImportRequest, IngestMode } from "../types/models";

export interface DesktopImportedPhoto {
  name: string;
  relativePath: string;
  filePath: string;
  sidecarPath: string | null;
  ingestMode: IngestMode;
  bytes: ArrayBuffer;
  sidecarText: string | null;
}

export interface DesktopPickImportResult {
  entries: DesktopImportedPhoto[];
}

export interface DesktopBridge {
  platform: "electron";
  pickImport(request: ImportRequest): Promise<DesktopPickImportResult>;
  persistSidecar(request: { filePath: string; sidecarText: string }): Promise<{ sidecarPath: string }>;
  exportFiles(request: {
    files: ExportFilePayload[];
    suggestedFolderName: string;
  }): Promise<{ written: number }>;
}

export function getDesktopBridge() {
  return window.dj1000Desktop ?? null;
}

export function isDesktopRuntime(): boolean {
  return getDesktopBridge() !== null;
}
