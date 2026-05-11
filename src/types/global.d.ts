/* eslint-disable @typescript-eslint/no-unused-vars */

import type { DesktopBridge } from "../platform/desktop";

declare global {
  interface FilePickerAcceptType {
    description?: string;
    accept: Record<string, string[]>;
  }

  interface OpenFilePickerOptions {
    multiple?: boolean;
    types?: FilePickerAcceptType[];
  }

  interface FileSystemHandle {
    kind: "file" | "directory";
    name: string;
  }

  interface FileSystemFileHandle extends FileSystemHandle {
    kind: "file";
    getFile(): Promise<File>;
  }

  interface FileSystemDirectoryHandle extends FileSystemHandle {
    kind: "directory";
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }

  interface Window {
    dj1000Desktop?: DesktopBridge;
    showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  }
}

declare module "react" {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string;
    directory?: string;
  }
}

export {};
