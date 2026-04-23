import JSZip from "jszip";

import { createTransformedFrameCanvas } from "./frameTransforms";
import { stringifySidecar } from "./sidecar";
import type {
  ExportFilePayload,
  PhotoEdits,
  PhotoRecord,
  RenderExportFormat,
  RenderedFrame,
} from "../types/models";

export interface BrowserExportFile {
  name: string;
  blob: Blob;
}

function updateFnv1a(hash: number, value: number) {
  return Math.imul(hash ^ value, 0x01000193) >>> 0;
}

function sliceTypedArrayBuffer(bytes: Uint8Array) {
  return Uint8Array.from(bytes).buffer;
}

function normalizeArchivePath(input: string) {
  return input.replaceAll("\\", "/").replace(/^\/+/, "");
}

function buildExportIdentifier(datBytes: Uint8Array) {
  let hash = 0x811c9dc5;
  for (const value of datBytes) {
    hash = updateFnv1a(hash, value);
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildIdentifiedExportStem(relativePath: string, datBytes: Uint8Array) {
  const normalizedPath = normalizeArchivePath(relativePath);
  const stem = normalizedPath.replace(/\.dat$/i, "");
  return `${stem}-${buildExportIdentifier(datBytes)}`;
}

export async function renderFrameToBlob(frame: RenderedFrame, edits: PhotoEdits, format: RenderExportFormat) {
  const canvas = createTransformedFrameCanvas(frame, edits);
  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
  const quality = format === "jpeg" ? 0.95 : undefined;
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) {
        resolve(value);
        return;
      }
      reject(new Error(`Failed to encode ${format.toUpperCase()} blob.`));
    }, mimeType, quality);
  });
  return blob;
}

export async function renderFrameToDownloadFile(
  frame: RenderedFrame,
  edits: PhotoEdits,
  format: RenderExportFormat,
  baseName: string,
) {
  const extension = format === "jpeg" ? "jpg" : "png";
  const blob = await renderFrameToBlob(frame, edits, format);
  return {
    filename: `${baseName}.${extension}`,
    blob,
  };
}

export function buildBrowserSourceBundle(photo: PhotoRecord) {
  const basePath = normalizeArchivePath(photo.relativePath || photo.name);
  return [
    {
      name: `${basePath}.json`,
      blob: new Blob([stringifySidecar(photo.edits, photo.metadata, photo.sidecar)], { type: "application/json" }),
    },
    {
      name: basePath,
      blob: new Blob([sliceTypedArrayBuffer(photo.datBytes)], { type: "application/octet-stream" }),
    },
  ] satisfies BrowserExportFile[];
}

export function buildDesktopSourceBundle(photo: PhotoRecord) {
  return [
    {
      relativePath: `${photo.name}.json`,
      bytes: new TextEncoder().encode(stringifySidecar(photo.edits, photo.metadata, photo.sidecar)).buffer,
    },
    {
      relativePath: photo.name,
      bytes: sliceTypedArrayBuffer(photo.datBytes),
    },
  ] satisfies ExportFilePayload[];
}

export function buildBrowserDngExportBundle(
  photo: PhotoRecord,
  dngBytes: Uint8Array,
  includeSourceBundle: boolean,
) {
  const basePath = normalizeArchivePath(photo.relativePath || photo.name);
  const stem = buildIdentifiedExportStem(basePath, photo.datBytes);
  const files: BrowserExportFile[] = [
    {
      name: `${stem}.dng`,
      blob: new Blob([sliceTypedArrayBuffer(dngBytes)], { type: "image/x-adobe-dng" }),
    },
  ];

  if (includeSourceBundle) {
    files.push(...buildBrowserSourceBundle(photo));
  }

  return files;
}

export function buildDesktopDngExportPayload(
  photo: PhotoRecord,
  dngBytes: Uint8Array,
  includeSourceBundle: boolean,
) {
  const stem = buildIdentifiedExportStem(photo.relativePath, photo.datBytes);
  const files: ExportFilePayload[] = [
    {
      relativePath: `${stem}.dng`,
      bytes: sliceTypedArrayBuffer(dngBytes),
    },
  ];

  if (includeSourceBundle) {
    files.push(...buildDesktopSourceBundle(photo));
  }

  return files;
}

export function triggerBrowserDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function buildBrowserExportArchive(files: BrowserExportFile[]) {
  const archive = new JSZip();
  for (const file of files) {
    archive.file(normalizeArchivePath(file.name), file.blob);
  }
  return archive.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

export async function buildBrowserExportArchiveWithProgress(
  files: BrowserExportFile[],
  onProgress?: (percent: number, currentFile: string | null) => void,
) {
  const archive = new JSZip();
  for (const file of files) {
    archive.file(normalizeArchivePath(file.name), file.blob);
  }
  return archive.generateAsync(
    {
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    },
    (metadata) => {
      onProgress?.(metadata.percent, metadata.currentFile ?? null);
    },
  );
}

export async function buildBrowserExportBundle(
  photo: PhotoRecord,
  frame: RenderedFrame,
  format: RenderExportFormat,
  includeSourceBundle: boolean,
) {
  const stem = buildIdentifiedExportStem(photo.relativePath || photo.name, photo.datBytes);
  const rendered = await renderFrameToDownloadFile(frame, photo.edits, format, stem);
  const files: BrowserExportFile[] = [{ name: rendered.filename, blob: rendered.blob }];

  if (includeSourceBundle) {
    files.push(...buildBrowserSourceBundle(photo));
  }

  return files;
}

export async function buildDesktopExportPayload(
  photo: PhotoRecord,
  frame: RenderedFrame,
  format: RenderExportFormat,
  includeSourceBundle: boolean,
) {
  const stem = buildIdentifiedExportStem(photo.relativePath, photo.datBytes);
  const rendered = await renderFrameToDownloadFile(frame, photo.edits, format, stem);
  const renderedBytes = await rendered.blob.arrayBuffer();
  const files: ExportFilePayload[] = [
    {
      relativePath: rendered.filename,
      bytes: renderedBytes,
    },
  ];

  if (includeSourceBundle) {
    files.push(...buildDesktopSourceBundle(photo));
  }

  return files;
}
