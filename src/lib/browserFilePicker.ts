/**
 * File System Access API: Chromium shows an "Open" dialog (local files), unlike <input type="file">
 * which is often labeled "upload". We only use it when it is likely to work end-to-end.
 *
 * Important: after any `await` from a click handler, calling `input.click()` usually does *not*
 * keep user activation, so "try FS, then fall back to input" breaks in Brave and strict Chromium.
 */

export type FsPickOutcome =
  | { kind: "picked"; files: File[]; totalScannedEntries: number }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

const datPickerTypes = [
  {
    description: "DJ-1000 photo (.dat)",
    accept: {
      "application/octet-stream": [".dat"],
    },
  },
];

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Brave (and similar) often blocks or mishandles FS Access; fallback must be synchronous input.click(). */
function isBraveBrowser(): boolean {
  return /\bBrave\//i.test(navigator.userAgent);
}

/**
 * Use FS Access only in contexts where we will not need a post-await `<input>.click()` fallback
 * (that fallback is unreliable after user activation is consumed).
 */
export function shouldUseFileSystemAccessApi(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (!window.isSecureContext) {
    return false;
  }
  if (isBraveBrowser()) {
    return false;
  }
  if (typeof window.showOpenFilePicker !== "function" || typeof window.showDirectoryPicker !== "function") {
    return false;
  }
  return true;
}

async function collectFromDirectory(
  dirHandle: FileSystemDirectoryHandle,
  basePath = "",
): Promise<{ files: File[]; totalScannedEntries: number }> {
  const files: File[] = [];
  let totalScannedEntries = 0;

  for await (const [name, handle] of dirHandle.entries()) {
    const rel = basePath ? `${basePath}/${name}` : name;
    if (handle.kind === "directory") {
      const nested = await collectFromDirectory(handle as FileSystemDirectoryHandle, rel);
      files.push(...nested.files);
      totalScannedEntries += nested.totalScannedEntries;
      continue;
    }

    totalScannedEntries += 1;
    if (!/\.dat$/i.test(name) && !/\.dat\.json$/i.test(name)) {
      continue;
    }

    const file = await (handle as FileSystemFileHandle).getFile();
    Object.defineProperty(file, "webkitRelativePath", {
      value: rel,
      configurable: true,
      enumerable: true,
      writable: false,
    });
    files.push(file);
  }

  return { files, totalScannedEntries };
}

/** Call only when `shouldUseFileSystemAccessApi()` is true. Never use post-await input fallback. */
export async function pickDatFilesWithFsApi(): Promise<FsPickOutcome> {
  try {
    const handles = await window.showOpenFilePicker!({
      multiple: true,
      types: datPickerTypes,
    });
    if (handles.length === 0) {
      return { kind: "cancelled" };
    }
    const files = await Promise.all(handles.map((handle: FileSystemFileHandle) => handle.getFile()));
    return { kind: "picked", files, totalScannedEntries: files.length };
  } catch (error) {
    if (isAbortError(error)) {
      return { kind: "cancelled" };
    }
    return {
      kind: "failed",
      message:
        "Could not open files with the native file dialog. Try again, or use a different browser if this keeps happening.",
    };
  }
}

/** Call only when `shouldUseFileSystemAccessApi()` is true. */
export async function pickDatFolderWithFsApi(): Promise<FsPickOutcome> {
  try {
    const dirHandle = await window.showDirectoryPicker!();
    const { files, totalScannedEntries } = await collectFromDirectory(dirHandle);
    return { kind: "picked", files, totalScannedEntries };
  } catch (error) {
    if (isAbortError(error)) {
      return { kind: "cancelled" };
    }
    return {
      kind: "failed",
      message:
        "Could not open that folder. Try again, or use a different browser if this keeps happening.",
    };
  }
}
