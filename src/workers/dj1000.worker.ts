type SessionHandle = {
  renderToRgba(options?: Record<string, unknown>): {
    width: number;
    height: number;
    pixels: Uint8Array;
  };
  close(): void;
};

interface WorkerConverter {
  openSession(input: Uint8Array): SessionHandle;
}

type WorkerRenderOptions = {
  size: "small" | "normal" | "large";
  redBalance: number;
  greenBalance: number;
  blueBalance: number;
  contrast: number;
  brightness: number;
  vividness: number;
  sharpness: number;
};

type WorkerRequest =
  | { type: "open-document"; photoId: string; bytes: ArrayBuffer }
  | { type: "close-document"; photoId: string }
  | {
      type: "render";
      photoId: string;
      requestId: number;
      intent: "thumbnail" | "preview" | "export";
      options: WorkerRenderOptions;
    }
  | { type: "dispose" };

type RenderJob = Extract<WorkerRequest, { type: "render" }> & {
  priority: number;
  order: number;
};

let converterPromise: Promise<WorkerConverter> | null = null;
const sessions = new Map<string, SessionHandle>();
const pendingJobs = new Map<string, RenderJob>();
let activeJob: RenderJob | null = null;
let jobSequence = 0;
const scope = self as unknown as Worker;

async function loadConverter() {
  if (converterPromise !== null) {
    return converterPromise;
  }

  const helperUrl = new URL(`${import.meta.env.BASE_URL}vendor/dj1000/dj1000_wasm_api.mjs`, self.location.href);
  converterPromise = import(helperUrl.href)
    .then(({ createDj1000WasmConverter }) => createDj1000WasmConverter())
    .catch((error) => {
      converterPromise = null;
      throw error;
    });
  return converterPromise;
}

function renderKey(photoId: string, intent: RenderJob["intent"]) {
  return `${photoId}:${intent}`;
}

function renderPriority(intent: RenderJob["intent"]) {
  switch (intent) {
    case "export":
      return 4;
    case "preview":
      return 3;
    case "thumbnail":
      return 2;
    default:
      return 1;
  }
}

function nextQueuedJob() {
  return Array.from(pendingJobs.values()).sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return left.order - right.order;
  })[0];
}

async function processQueue() {
  if (activeJob !== null) {
    return;
  }

  const nextJob = nextQueuedJob();
  if (!nextJob) {
    return;
  }

  pendingJobs.delete(renderKey(nextJob.photoId, nextJob.intent));
  activeJob = nextJob;

  try {
    const session = sessions.get(nextJob.photoId);
    if (!session) {
      throw new Error(`No open session for ${nextJob.photoId}.`);
    }

    const result = session.renderToRgba(nextJob.options);
    scope.postMessage(
      {
        type: "render-complete",
        photoId: nextJob.photoId,
        requestId: nextJob.requestId,
        width: result.width,
        height: result.height,
        pixels: result.pixels.buffer,
      },
      [result.pixels.buffer],
    );
  } catch (error) {
    scope.postMessage({
      type: "render-error",
      photoId: nextJob.photoId,
      requestId: nextJob.requestId,
      error: String(error instanceof Error ? error.message : error),
    });
  } finally {
    activeJob = null;
    void processQueue();
  }
}

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  switch (message.type) {
    case "open-document": {
      try {
        const converter = await loadConverter();
        const existing = sessions.get(message.photoId);
        existing?.close();
        sessions.set(message.photoId, converter.openSession(new Uint8Array(message.bytes)));
        scope.postMessage({ type: "document-opened", photoId: message.photoId });
      } catch (error) {
        scope.postMessage({
          type: "document-open-error",
          photoId: message.photoId,
          error: String(error instanceof Error ? error.message : error),
        });
      }
      return;
    }
    case "close-document": {
      sessions.get(message.photoId)?.close();
      sessions.delete(message.photoId);
      pendingJobs.delete(renderKey(message.photoId, "thumbnail"));
      pendingJobs.delete(renderKey(message.photoId, "preview"));
      pendingJobs.delete(renderKey(message.photoId, "export"));
      return;
    }
    case "render": {
      pendingJobs.set(renderKey(message.photoId, message.intent), {
        ...message,
        priority: renderPriority(message.intent),
        order: ++jobSequence,
      });
      void processQueue();
      return;
    }
    case "dispose": {
      for (const session of sessions.values()) {
        session.close();
      }
      sessions.clear();
      pendingJobs.clear();
      converterPromise = null;
      activeJob = null;
      self.close();
      return;
    }
  }
});
/// <reference lib="webworker" />
