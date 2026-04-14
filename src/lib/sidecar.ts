import {
  defaultEdits,
  defaultMetadata,
  type PhotoEdits,
  type PhotoMetadata,
  type PhotoRotation,
  type PhotoReviewStatus,
  type PhotoSidecar,
} from "../types/models";

function clamp(number: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, number));
}

export function normalizeEdits(candidate: Partial<PhotoEdits> | undefined): PhotoEdits {
  const defaults = defaultEdits();
  const rotation: PhotoRotation =
    candidate?.rotation === 90 || candidate?.rotation === 180 || candidate?.rotation === 270
      ? candidate.rotation
      : defaults.rotation;

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
    rotation,
    flipHorizontal: candidate?.flipHorizontal === true,
    flipVertical: candidate?.flipVertical === true,
  };
}

export function normalizeMetadata(candidate: Partial<PhotoMetadata> | undefined): PhotoMetadata {
  const defaults = defaultMetadata();
  const reviewStatus: PhotoReviewStatus =
    candidate?.reviewStatus === "flagged" || candidate?.reviewStatus === "rejected"
      ? candidate.reviewStatus
      : defaults.reviewStatus;

  return {
    rating: clamp(candidate?.rating ?? defaults.rating, 0, 5),
    reviewStatus,
    removed: candidate?.removed === true,
  };
}

export function parseSidecarText(sidecarText?: string | null): {
  edits: PhotoEdits;
  metadata: PhotoMetadata;
} {
  if (!sidecarText) {
    return {
      edits: defaultEdits(),
      metadata: defaultMetadata(),
    };
  }

  try {
    const parsed = JSON.parse(sidecarText) as Partial<PhotoSidecar> & {
      settings?: Partial<PhotoEdits>;
      edits?: Partial<PhotoEdits>;
      metadata?: Partial<PhotoMetadata>;
    };

    return {
      edits: normalizeEdits(parsed.edits ?? parsed.settings),
      metadata: normalizeMetadata(parsed.metadata),
    };
  } catch {
    return {
      edits: defaultEdits(),
      metadata: defaultMetadata(),
    };
  }
}

export function createSidecar(edits: PhotoEdits, metadata: PhotoMetadata): PhotoSidecar {
  return {
    schema: "dj1000-photo-settings/v1",
    edits: normalizeEdits(edits),
    metadata: normalizeMetadata(metadata),
    updatedAt: new Date().toISOString(),
  };
}

export function stringifySidecar(edits: PhotoEdits, metadata: PhotoMetadata) {
  return JSON.stringify(createSidecar(edits, metadata), null, 2);
}
