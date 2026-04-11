import { parseSidecarText } from "./sidecar";
import type { ImportedPhotoPayload, PhotoRecord } from "../types/models";

function fileKey(name: string) {
  return name.toUpperCase();
}

function toUint8Array(buffer: ArrayBuffer) {
  return new Uint8Array(buffer.slice(0));
}

function resolveSidecarText(
  datFileName: string,
  sidecars: Map<string, string>,
) {
  return sidecars.get(fileKey(`${datFileName}.json`)) ?? null;
}

export async function parseBrowserImport(files: FileList | File[], ingestMode: PhotoRecord["ingestMode"]) {
  const datFiles = Array.from(files).filter((file) => /\.dat$/i.test(file.name));
  const sidecarFiles = Array.from(files).filter((file) => /\.dat\.json$/i.test(file.name));

  const sidecars = new Map<string, string>();
  await Promise.all(
    sidecarFiles.map(async (file) => {
      sidecars.set(fileKey(file.name), await file.text());
    }),
  );

  const payloads = await Promise.all(
    datFiles.map(async (file) => ({
      name: file.name,
      relativePath: "webkitRelativePath" in file && typeof file.webkitRelativePath === "string" && file.webkitRelativePath
        ? file.webkitRelativePath
        : file.name,
      ingestMode,
      bytes: toUint8Array(await file.arrayBuffer()),
      sidecarText: resolveSidecarText(file.name, sidecars),
    })),
  );

  return payloads as ImportedPhotoPayload[];
}

export function createPhotoRecord(payload: ImportedPhotoPayload): PhotoRecord {
  const edits = parseSidecarText(payload.sidecarText);
  return {
    id: crypto.randomUUID(),
    name: payload.name,
    relativePath: payload.relativePath,
    filePath: payload.filePath,
    sidecarPath: payload.sidecarPath ?? null,
    ingestMode: payload.ingestMode,
    datBytes: payload.bytes,
    edits,
    previewStatus: "idle",
    thumbnailStatus: "idle",
  };
}
