import type { ExportUpscaleSettings, PhotoEdits, RenderedFrame } from "../types/models";

interface AxisContribution {
  indices: number[];
  weights: number[];
}

function createSourceCanvas(frame: RenderedFrame) {
  const source = document.createElement("canvas");
  source.width = frame.width;
  source.height = frame.height;
  const context = source.getContext("2d");
  if (!context) {
    throw new Error("Unable to create a source canvas.");
  }
  context.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0);
  return source;
}

function clampIndex(value: number, size: number) {
  return Math.min(size - 1, Math.max(0, value));
}

function sinc(value: number) {
  if (value === 0) {
    return 1;
  }
  const x = value * Math.PI;
  return Math.sin(x) / x;
}

function lanczos3Weight(distance: number) {
  const x = Math.abs(distance);
  return x < 3 ? sinc(x) * sinc(x / 3) : 0;
}

function buildAxisContributions(
  sourceSize: number,
  outputSize: number,
  radius: number,
  kernel: (distance: number) => number,
): AxisContribution[] {
  const scale = sourceSize / outputSize;
  return Array.from({ length: outputSize }, (_, outputIndex) => {
    const sourcePosition = (outputIndex + 0.5) * scale - 0.5;
    const start = Math.ceil(sourcePosition - radius);
    const end = Math.floor(sourcePosition + radius);
    const indices: number[] = [];
    const weights: number[] = [];
    let totalWeight = 0;

    for (let sourceIndex = start; sourceIndex <= end; sourceIndex += 1) {
      const weight = kernel(sourcePosition - sourceIndex);
      if (weight === 0) {
        continue;
      }
      indices.push(clampIndex(sourceIndex, sourceSize));
      weights.push(weight);
      totalWeight += weight;
    }

    if (totalWeight !== 0) {
      for (let index = 0; index < weights.length; index += 1) {
        weights[index] /= totalWeight;
      }
    }

    return { indices, weights };
  });
}

function upscaleImageDataNearest(source: ImageData, scale: number) {
  const outputWidth = source.width * scale;
  const outputHeight = source.height * scale;
  const output = new ImageData(outputWidth, outputHeight);
  const sourcePixels = source.data;
  const outputPixels = output.data;

  for (let y = 0; y < outputHeight; y += 1) {
    const sourceY = Math.floor(y / scale);
    for (let x = 0; x < outputWidth; x += 1) {
      const sourceX = Math.floor(x / scale);
      const sourceOffset = ((sourceY * source.width) + sourceX) * 4;
      const outputOffset = ((y * outputWidth) + x) * 4;
      outputPixels[outputOffset] = sourcePixels[sourceOffset];
      outputPixels[outputOffset + 1] = sourcePixels[sourceOffset + 1];
      outputPixels[outputOffset + 2] = sourcePixels[sourceOffset + 2];
      outputPixels[outputOffset + 3] = sourcePixels[sourceOffset + 3];
    }
  }

  return output;
}

function upscaleImageDataFiltered(
  source: ImageData,
  scale: number,
  radius: number,
  kernel: (distance: number) => number,
) {
  const outputWidth = source.width * scale;
  const outputHeight = source.height * scale;
  const xContributions = buildAxisContributions(source.width, outputWidth, radius, kernel);
  const yContributions = buildAxisContributions(source.height, outputHeight, radius, kernel);
  const horizontal = new Float32Array(outputWidth * source.height * 4);
  const sourcePixels = source.data;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      const contribution = xContributions[x];
      const outputOffset = ((y * outputWidth) + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        let value = 0;
        for (let index = 0; index < contribution.indices.length; index += 1) {
          const sourceOffset = ((y * source.width) + contribution.indices[index]) * 4;
          value += sourcePixels[sourceOffset + channel] * contribution.weights[index];
        }
        horizontal[outputOffset + channel] = value;
      }
    }
  }

  const output = new ImageData(outputWidth, outputHeight);
  const outputPixels = output.data;

  for (let y = 0; y < outputHeight; y += 1) {
    const yContribution = yContributions[y];
    for (let x = 0; x < outputWidth; x += 1) {
      const outputOffset = ((y * outputWidth) + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        let value = 0;
        for (let index = 0; index < yContribution.indices.length; index += 1) {
          const horizontalOffset = ((yContribution.indices[index] * outputWidth) + x) * 4;
          value += horizontal[horizontalOffset + channel] * yContribution.weights[index];
        }
        outputPixels[outputOffset + channel] = value;
      }
    }
  }

  return output;
}

function upscaleImageData(source: ImageData, upscale: ExportUpscaleSettings) {
  switch (upscale.algorithm) {
    case "bilinear":
      return upscaleImageDataFiltered(source, upscale.scale, 1, (distance) => Math.max(0, 1 - Math.abs(distance)));
    case "lanczos3":
      return upscaleImageDataFiltered(source, upscale.scale, 3, lanczos3Weight);
    case "nearest":
    default:
      return upscaleImageDataNearest(source, upscale.scale);
  }
}

export function getTransformedFrameSize(frame: RenderedFrame, edits: PhotoEdits) {
  const quarterTurn = edits.rotation === 90 || edits.rotation === 270;
  return quarterTurn
    ? { width: frame.height, height: frame.width }
    : { width: frame.width, height: frame.height };
}

export function drawFrameToCanvas(canvas: HTMLCanvasElement, frame: RenderedFrame, edits: PhotoEdits) {
  const output = getTransformedFrameSize(frame, edits);
  canvas.width = output.width;
  canvas.height = output.height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create a canvas rendering context.");
  }

  const source = createSourceCanvas(frame);
  context.clearRect(0, 0, output.width, output.height);
  context.save();
  context.translate(output.width / 2, output.height / 2);
  context.scale(edits.flipHorizontal ? -1 : 1, edits.flipVertical ? -1 : 1);
  context.rotate((edits.rotation * Math.PI) / 180);
  context.drawImage(source, -frame.width / 2, -frame.height / 2, frame.width, frame.height);
  context.restore();
}

export function upscaleCanvas(source: HTMLCanvasElement, upscale?: ExportUpscaleSettings) {
  const scale = upscale?.scale ?? 1;
  if (scale === 1) {
    return source;
  }

  const canvas = document.createElement("canvas");
  canvas.width = source.width * scale;
  canvas.height = source.height * scale;
  const context = canvas.getContext("2d");
  const sourceContext = source.getContext("2d");
  if (!context) {
    throw new Error("Unable to create an upscaling canvas rendering context.");
  }
  if (!sourceContext) {
    throw new Error("Unable to read source pixels for upscaling.");
  }

  const imageData = sourceContext.getImageData(0, 0, source.width, source.height);
  context.putImageData(upscaleImageData(imageData, upscale ?? { scale, algorithm: "nearest" }), 0, 0);
  return canvas;
}

export function createTransformedFrameCanvas(frame: RenderedFrame, edits: PhotoEdits, upscale?: ExportUpscaleSettings) {
  const canvas = document.createElement("canvas");
  drawFrameToCanvas(canvas, frame, edits);
  return upscaleCanvas(canvas, upscale);
}
