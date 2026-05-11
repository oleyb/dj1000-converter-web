import type { PhotoEdits, RenderIntent, RenderedFrame } from "../types/models";

interface WorkerRenderOptions {
  size: "small" | "normal" | "large";
  redBalance: number;
  greenBalance: number;
  blueBalance: number;
  contrast: number;
  brightness: number;
  vividness: number;
  sharpness: number;
}

type WorkerRequest =
  | { type: "get-capabilities"; requestId: number }
  | { type: "open-document"; photoId: string; bytes: ArrayBuffer }
  | { type: "close-document"; photoId: string }
  | { type: "convert-dng"; requestId: number; bytes: ArrayBuffer }
  | {
      type: "render";
      photoId: string;
      requestId: number;
      intent: RenderIntent;
      options: WorkerRenderOptions;
    }
  | { type: "dispose" };

type WorkerResponse =
  | { type: "capabilities"; requestId: number; supportsDng: boolean; error?: string }
  | { type: "document-opened"; photoId: string }
  | { type: "document-open-error"; photoId: string; error: string }
  | { type: "convert-dng-complete"; requestId: number; bytes: ArrayBuffer }
  | { type: "convert-dng-error"; requestId: number; error: string }
  | {
      type: "render-complete";
      photoId: string;
      requestId: number;
      width: number;
      height: number;
      pixels: ArrayBuffer;
    }
  | { type: "render-error"; photoId: string; requestId: number; error: string };

interface WorkerSlot {
  worker: Worker;
  photoIds: Set<string>;
}

interface PendingOpen {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingRender {
  resolve: (frame: RenderedFrame) => void;
  reject: (error: Error) => void;
}

interface PendingDng {
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
}

interface PendingCapabilities {
  resolve: (capabilities: { supportsDng: boolean }) => void;
  reject: (error: Error) => void;
}

function toWorkerOptions(edits: PhotoEdits): WorkerRenderOptions {
  return {
    size: edits.size,
    redBalance: edits.redBalance,
    greenBalance: edits.greenBalance,
    blueBalance: edits.blueBalance,
    contrast: edits.contrast + 3,
    brightness: edits.brightness + 3,
    vividness: edits.vividness + 3,
    sharpness: edits.sharpness + 3,
  };
}

export class Dj1000RenderPool {
  private readonly workers: WorkerSlot[];
  private readonly photoToWorker = new Map<string, WorkerSlot>();
  private readonly pendingOpens = new Map<string, PendingOpen>();
  private readonly pendingRenders = new Map<number, PendingRender>();
  private readonly pendingDngConversions = new Map<number, PendingDng>();
  private readonly pendingCapabilities = new Map<number, PendingCapabilities>();
  private nextRenderRequestId = 1;
  private capabilitiesPromise: Promise<{ supportsDng: boolean }> | null = null;

  constructor(workerCount = Math.min(4, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)))) {
    this.workers = Array.from({ length: workerCount }, () => {
      const worker = new Worker(new URL("../workers/dj1000.worker.ts", import.meta.url), {
        type: "module",
      });
      const slot: WorkerSlot = { worker, photoIds: new Set() };
      worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
        this.handleWorkerMessage(slot, event.data);
      });
      return slot;
    });
  }

  async openDocument(photoId: string, bytes: Uint8Array) {
    const slot = this.pickWorkerSlot();
    this.photoToWorker.set(photoId, slot);
    slot.photoIds.add(photoId);

    const payload = bytes.slice().buffer;
    await new Promise<void>((resolve, reject) => {
      this.pendingOpens.set(photoId, { resolve, reject });
      const message: WorkerRequest = { type: "open-document", photoId, bytes: payload };
      slot.worker.postMessage(message, [payload]);
    });
  }

  render(photoId: string, edits: PhotoEdits, intent: RenderIntent) {
    const slot = this.photoToWorker.get(photoId);
    if (!slot) {
      return Promise.reject(new Error(`No worker session exists for photo ${photoId}.`));
    }

    const requestId = this.nextRenderRequestId++;
    return new Promise<RenderedFrame>((resolve, reject) => {
      this.pendingRenders.set(requestId, { resolve, reject });
      const message: WorkerRequest = {
        type: "render",
        photoId,
        requestId,
        intent,
        options: toWorkerOptions(edits),
      };
      slot.worker.postMessage(message);
    });
  }

  getCapabilities() {
    if (this.capabilitiesPromise) {
      return this.capabilitiesPromise;
    }

    const requestId = this.nextRenderRequestId++;
    const slot = this.workers[0];
    this.capabilitiesPromise = new Promise<{ supportsDng: boolean }>((resolve, reject) => {
      this.pendingCapabilities.set(requestId, { resolve, reject });
      const message: WorkerRequest = {
        type: "get-capabilities",
        requestId,
      };
      slot.worker.postMessage(message);
    }).catch((error) => {
      this.capabilitiesPromise = null;
      throw error;
    });

    return this.capabilitiesPromise;
  }

  convertDatToDng(bytes: Uint8Array, preferredPhotoId?: string) {
    const slot = preferredPhotoId ? this.photoToWorker.get(preferredPhotoId) ?? this.pickWorkerSlot() : this.pickWorkerSlot();
    const requestId = this.nextRenderRequestId++;
    const payload = bytes.slice().buffer;

    return new Promise<Uint8Array>((resolve, reject) => {
      this.pendingDngConversions.set(requestId, { resolve, reject });
      const message: WorkerRequest = {
        type: "convert-dng",
        requestId,
        bytes: payload,
      };
      slot.worker.postMessage(message, [payload]);
    });
  }

  closeDocument(photoId: string) {
    const slot = this.photoToWorker.get(photoId);
    if (!slot) {
      return;
    }

    slot.worker.postMessage({ type: "close-document", photoId } satisfies WorkerRequest);
    slot.photoIds.delete(photoId);
    this.photoToWorker.delete(photoId);
  }

  dispose() {
    for (const slot of this.workers) {
      slot.worker.postMessage({ type: "dispose" } satisfies WorkerRequest);
      slot.worker.terminate();
    }
    this.pendingOpens.clear();
    this.pendingRenders.clear();
    this.pendingDngConversions.clear();
    this.pendingCapabilities.clear();
    this.photoToWorker.clear();
    this.capabilitiesPromise = null;
  }

  private pickWorkerSlot() {
    return this.workers.reduce((best, candidate) =>
      candidate.photoIds.size < best.photoIds.size ? candidate : best,
    );
  }

  private handleWorkerMessage(_slot: WorkerSlot, message: WorkerResponse) {
    switch (message.type) {
      case "capabilities": {
        const pending = this.pendingCapabilities.get(message.requestId);
        if (pending) {
          this.pendingCapabilities.delete(message.requestId);
          if (message.error) {
            pending.reject(new Error(message.error));
          } else {
            pending.resolve({ supportsDng: message.supportsDng });
          }
        }
        return;
      }
      case "document-opened": {
        const pending = this.pendingOpens.get(message.photoId);
        if (pending) {
          this.pendingOpens.delete(message.photoId);
          pending.resolve();
        }
        return;
      }
      case "document-open-error": {
        const pending = this.pendingOpens.get(message.photoId);
        if (pending) {
          this.pendingOpens.delete(message.photoId);
          pending.reject(new Error(message.error));
        }
        return;
      }
      case "render-complete": {
        const pending = this.pendingRenders.get(message.requestId);
        if (pending) {
          this.pendingRenders.delete(message.requestId);
          pending.resolve({
            width: message.width,
            height: message.height,
            pixels: new Uint8Array(message.pixels),
          });
        }
        return;
      }
      case "render-error": {
        const pending = this.pendingRenders.get(message.requestId);
        if (pending) {
          this.pendingRenders.delete(message.requestId);
          pending.reject(new Error(message.error));
        }
        return;
      }
      case "convert-dng-complete": {
        const pending = this.pendingDngConversions.get(message.requestId);
        if (pending) {
          this.pendingDngConversions.delete(message.requestId);
          pending.resolve(new Uint8Array(message.bytes));
        }
        return;
      }
      case "convert-dng-error": {
        const pending = this.pendingDngConversions.get(message.requestId);
        if (pending) {
          this.pendingDngConversions.delete(message.requestId);
          pending.reject(new Error(message.error));
        }
        return;
      }
    }
  }
}
