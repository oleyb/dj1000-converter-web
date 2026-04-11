import { defaultEdits, type PhotoEdits, type PhotoSidecar } from "../types/models";

function clamp(number: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, number));
}

export function normalizeEdits(candidate: Partial<PhotoEdits> | undefined): PhotoEdits {
  const defaults = defaultEdits();
  return {
    size:
      candidate?.size === "small" || candidate?.size === "normal" || candidate?.size === "large"
        ? candidate.size
        : defaults.size,
    redBalance: clamp(candidate?.redBalance ?? defaults.redBalance, 0, 200),
    greenBalance: clamp(candidate?.greenBalance ?? defaults.greenBalance, 0, 200),
    blueBalance: clamp(candidate?.blueBalance ?? defaults.blueBalance, 0, 200),
    contrast: clamp(candidate?.contrast ?? defaults.contrast, -3, 3),
    brightness: clamp(candidate?.brightness ?? defaults.brightness, -3, 3),
    vividness: clamp(candidate?.vividness ?? defaults.vividness, -3, 3),
    sharpness: clamp(candidate?.sharpness ?? defaults.sharpness, -3, 3),
  };
}

export function parseSidecarText(sidecarText?: string | null): PhotoEdits {
  if (!sidecarText) {
    return defaultEdits();
  }

  try {
    const parsed = JSON.parse(sidecarText) as Partial<PhotoSidecar> & {
      settings?: Partial<PhotoEdits>;
      edits?: Partial<PhotoEdits>;
    };
    if (parsed.schema !== "dj1000-photo-settings/v1") {
      return normalizeEdits(parsed.edits ?? parsed.settings);
    }
    return normalizeEdits(parsed.edits);
  } catch {
    return defaultEdits();
  }
}

export function createSidecar(edits: PhotoEdits): PhotoSidecar {
  return {
    schema: "dj1000-photo-settings/v1",
    edits: normalizeEdits(edits),
    updatedAt: new Date().toISOString(),
  };
}

export function stringifySidecar(edits: PhotoEdits) {
  return JSON.stringify(createSidecar(edits), null, 2);
}
