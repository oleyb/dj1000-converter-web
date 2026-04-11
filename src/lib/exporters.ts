import JSZip from "jszip";

import { stringifySidecar } from "./sidecar";
import type {
  ExportFilePayload,
  ExportFormat,
  PhotoRecord,
  RenderedFrame,
} from "../types/models";

export interface BrowserExportFile {
  name: string;
  blob: Blob;
}

function sliceTypedArrayBuffer(bytes: Uint8Array) {
  return Uint8Array.from(bytes).buffer;
}

function normalizeArchivePath(input: string) {
  return input.replaceAll("\\", "/").replace(/^\/+/, "");
}

function renderFrameToCanvas(frame: RenderedFrame) {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create a canvas rendering context.");
  }
  const imageData = new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height);
  context.putImageData(imageData, 0, 0);
  return canvas;
}

export async function renderFrameToBlob(frame: RenderedFrame, format: ExportFormat) {
  const canvas = renderFrameToCanvas(frame);
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
  format: ExportFormat,
  baseName: string,
) {
  const extension = format === "jpeg" ? "jpg" : "png";
  const blob = await renderFrameToBlob(frame, format);
  return {
    filename: `${baseName}.${extension}`,
    blob,
  };
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

export async function buildBrowserExportBundle(
  photo: PhotoRecord,
  frame: RenderedFrame,
  format: ExportFormat,
  includeSourceBundle: boolean,
) {
  const basePath = normalizeArchivePath(photo.relativePath || photo.name);
  const stem = basePath.replace(/\.dat$/i, "");
  const rendered = await renderFrameToDownloadFile(frame, format, stem);
  const files: BrowserExportFile[] = [{ name: rendered.filename, blob: rendered.blob }];

  files.push({
    name: `${basePath}.json`,
    blob: new Blob([stringifySidecar(photo.edits)], { type: "application/json" }),
  });

  if (includeSourceBundle) {
    files.push({
      name: basePath,
      blob: new Blob([sliceTypedArrayBuffer(photo.datBytes)], { type: "application/octet-stream" }),
    });
  }

  return files;
}

export async function buildDesktopExportPayload(
  photo: PhotoRecord,
  frame: RenderedFrame,
  format: ExportFormat,
  includeSourceBundle: boolean,
) {
  const stem = photo.relativePath.replace(/\.dat$/i, "");
  const rendered = await renderFrameToDownloadFile(frame, format, stem);
  const renderedBytes = await rendered.blob.arrayBuffer();
  const files: ExportFilePayload[] = [
    {
      relativePath: rendered.filename,
      bytes: renderedBytes,
    },
    {
      relativePath: `${photo.name}.json`,
      bytes: new TextEncoder().encode(stringifySidecar(photo.edits)).buffer,
    },
  ];

  if (includeSourceBundle) {
    files.push({
      relativePath: photo.name,
      bytes: sliceTypedArrayBuffer(photo.datBytes),
    });
  }

  return files;
}
