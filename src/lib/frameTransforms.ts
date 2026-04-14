import type { PhotoEdits, RenderedFrame } from "../types/models";

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

export function createTransformedFrameCanvas(frame: RenderedFrame, edits: PhotoEdits) {
  const canvas = document.createElement("canvas");
  drawFrameToCanvas(canvas, frame, edits);
  return canvas;
}
