import {
  defaultEdits,
  defaultMetadata,
  type LegacyPipelineEdits,
  type PhotoEdits,
  type PhotoMetadata,
  type PhotoRotation,
  type PhotoReviewStatus,
  type PhotoPipelineEntry,
  type PhotoSidecar,
  type ViewEdits,
} from "../types/models";

const LEGACY_PIPELINE_ID = "legacy";

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

function splitEdits(edits: PhotoEdits): {
  converter: LegacyPipelineEdits;
  presentation: ViewEdits;
} {
  return {
    converter: {
      size: edits.size,
      redBalance: edits.redBalance,
      greenBalance: edits.greenBalance,
      blueBalance: edits.blueBalance,
      contrast: edits.contrast,
      brightness: edits.brightness,
      vividness: edits.vividness,
      sharpness: edits.sharpness,
    },
    presentation: {
      rotation: edits.rotation,
      flipHorizontal: edits.flipHorizontal,
      flipVertical: edits.flipVertical,
    },
  };
}

function normalizePipelineSettings(candidate: unknown): Partial<PhotoEdits> {
  if (!candidate || typeof candidate !== "object") {
    return {};
  }

  return candidate as Partial<PhotoEdits>;
}

function normalizePipelineMap(candidate: unknown): Record<string, PhotoPipelineEntry> {
  if (!candidate || typeof candidate !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(candidate).flatMap(([id, value]) => {
      if (!value || typeof value !== "object") {
        return [];
      }

      const entry = value as Partial<PhotoPipelineEntry>;
      const settings =
        entry.settings && typeof entry.settings === "object"
          ? (entry.settings as Record<string, unknown>)
          : {};
      const version = typeof entry.version === "number" && Number.isFinite(entry.version)
        ? entry.version
        : 1;
      return [[id, { version, settings } satisfies PhotoPipelineEntry]];
    }),
  );
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
  sidecar: PhotoSidecar | null;
} {
  if (!sidecarText) {
    return {
      edits: defaultEdits(),
      metadata: defaultMetadata(),
      sidecar: null,
    };
  }

  try {
    const parsed = JSON.parse(sidecarText) as Partial<PhotoSidecar> & {
      settings?: Partial<PhotoEdits>;
      edits?: Partial<PhotoEdits>;
      converter?: Partial<LegacyPipelineEdits>;
      presentation?: Partial<ViewEdits>;
      activePipeline?: string;
      pipelines?: Record<string, Partial<PhotoPipelineEntry>>;
      metadata?: Partial<PhotoMetadata>;
    };

    const normalizedPipelines = normalizePipelineMap(parsed.pipelines);
    const fallbackLegacySettings = {
      ...(parsed.settings ?? parsed.edits ?? {}),
      ...(parsed.converter ?? {}),
    } satisfies Partial<PhotoEdits>;
    const activePipeline =
      typeof parsed.activePipeline === "string" && parsed.activePipeline.trim().length > 0
        ? parsed.activePipeline
        : LEGACY_PIPELINE_ID;
    const legacyEntry = normalizedPipelines[LEGACY_PIPELINE_ID];
    const activeEntry = normalizedPipelines[activePipeline];
    const activePipelineSettings = normalizePipelineSettings(activeEntry?.settings);
    const legacyPipelineSettings = normalizePipelineSettings(legacyEntry?.settings);
    const mergedEdits = {
      ...fallbackLegacySettings,
      ...(activePipeline === LEGACY_PIPELINE_ID ? activePipelineSettings : legacyPipelineSettings),
      ...(parsed.presentation ?? {}),
    } satisfies Partial<PhotoEdits>;
    const normalizedEdits = normalizeEdits(mergedEdits);
    const split = splitEdits(normalizedEdits);
    const pipelines = {
      ...normalizedPipelines,
      [LEGACY_PIPELINE_ID]: {
        version: legacyEntry?.version ?? 1,
        settings: {
          ...(legacyEntry?.settings ?? {}),
          ...split.converter,
        },
      },
    } satisfies Record<string, PhotoPipelineEntry>;
    const sidecar: PhotoSidecar = {
      schema: "dj1000-photo-settings/v3",
      activePipeline,
      pipelines,
      presentation: split.presentation,
      metadata: normalizeMetadata(parsed.metadata),
      updatedAt:
        typeof parsed.updatedAt === "string" && parsed.updatedAt.length > 0
          ? parsed.updatedAt
          : new Date().toISOString(),
    };

    return {
      edits: normalizedEdits,
      metadata: sidecar.metadata,
      sidecar,
    };
  } catch {
    return {
      edits: defaultEdits(),
      metadata: defaultMetadata(),
      sidecar: null,
    };
  }
}

export function createSidecar(
  edits: PhotoEdits,
  metadata: PhotoMetadata,
  existingSidecar?: PhotoSidecar | null,
): PhotoSidecar {
  const normalizedEdits = normalizeEdits(edits);
  const split = splitEdits(normalizedEdits);
  const normalizedPipelines = normalizePipelineMap(existingSidecar?.pipelines);
  return {
    schema: "dj1000-photo-settings/v3",
    activePipeline: LEGACY_PIPELINE_ID,
    pipelines: {
      ...normalizedPipelines,
      [LEGACY_PIPELINE_ID]: {
        version: normalizedPipelines[LEGACY_PIPELINE_ID]?.version ?? 1,
        settings: { ...split.converter },
      },
    },
    presentation: split.presentation,
    metadata: normalizeMetadata(metadata),
    updatedAt: new Date().toISOString(),
  };
}

export function stringifySidecar(edits: PhotoEdits, metadata: PhotoMetadata, existingSidecar?: PhotoSidecar | null) {
  return JSON.stringify(createSidecar(edits, metadata, existingSidecar), null, 2);
}
