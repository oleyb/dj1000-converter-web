/* eslint-disable @typescript-eslint/no-unused-vars */

import type { DesktopBridge } from "../platform/desktop";

declare global {
  interface Window {
    dj1000Desktop?: DesktopBridge;
  }
}

declare module "react" {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string;
    directory?: string;
  }
}

export {};
