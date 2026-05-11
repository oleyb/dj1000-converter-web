import { GIFEncoder, applyPalette, quantize } from "gifenc";

import { createTransformedFrameCanvas } from "./frameTransforms";
import type { ExportUpscaleSettings, PhotoEdits, RenderedFrame } from "../types/models";

export interface AnimatedGifSourceFrame {
  frame: RenderedFrame;
  edits: PhotoEdits;
}

export interface AnimatedGifOptions {
  delayMs: number;
  upscale: ExportUpscaleSettings;
  onProgress?: (encodedFrames: number, totalFrames: number) => void;
}

function getCenteredFrameImageData(source: HTMLCanvasElement, width: number, height: number) {
  if (source.width === width && source.height === height) {
    const context = source.getContext("2d");
    if (!context) {
      throw new Error("Unable to read GIF frame pixels.");
    }
    return context.getImageData(0, 0, width, height);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to compose GIF frame.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(
    source,
    Math.floor((width - source.width) / 2),
    Math.floor((height - source.height) / 2),
  );
  return context.getImageData(0, 0, width, height);
}

export async function buildAnimatedGifBlob(frames: AnimatedGifSourceFrame[], options: AnimatedGifOptions) {
  if (frames.length === 0) {
    throw new Error("Animated GIF export needs at least one frame.");
  }

  const canvases = frames.map((entry) => createTransformedFrameCanvas(entry.frame, entry.edits, options.upscale));
  const width = Math.max(...canvases.map((canvas) => canvas.width));
  const height = Math.max(...canvases.map((canvas) => canvas.height));
  const gif = GIFEncoder({ initialCapacity: Math.max(4096, width * height) });

  for (const [index, canvas] of canvases.entries()) {
    const imageData = getCenteredFrameImageData(canvas, width, height);
    const palette = quantize(imageData.data, 256);
    const indexed = applyPalette(imageData.data, palette);
    gif.writeFrame(indexed, width, height, {
      palette,
      delay: options.delayMs,
      repeat: index === 0 ? 0 : undefined,
    });
    options.onProgress?.(index + 1, canvases.length);

    // Yield between frames so progress UI can breathe during larger GIFs.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }

  gif.finish();
  const gifBytes = gif.bytes();
  const output = new ArrayBuffer(gifBytes.byteLength);
  new Uint8Array(output).set(gifBytes);
  return new Blob([output], { type: "image/gif" });
}
