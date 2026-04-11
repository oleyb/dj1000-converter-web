import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dj1000Desktop", {
  platform: "electron",
  pickImport: (request: unknown) => ipcRenderer.invoke("desktop:pick-import", request),
  persistSidecar: (request: unknown) => ipcRenderer.invoke("desktop:persist-sidecar", request),
  exportFiles: (request: unknown) => ipcRenderer.invoke("desktop:export-files", request),
});
