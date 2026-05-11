import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type ImportKind = "files" | "folder";
type IngestMode = "in-place" | "copy";

interface PickImportRequest {
  kind: ImportKind;
  ingestMode: IngestMode;
}

interface ImportedPhotoPayload {
  name: string;
  filePath: string;
  relativePath: string;
  ingestMode: IngestMode;
  bytes: ArrayBuffer;
  sidecarText: string | null;
  sidecarPath: string | null;
}

interface PersistSidecarRequest {
  filePath: string;
  sidecarText: string;
}

interface ExportFilePayload {
  relativePath: string;
  bytes: ArrayBuffer;
}

interface ExportFilesRequest {
  files: ExportFilePayload[];
  suggestedFolderName: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getImportDefaultPath() {
  if (process.platform === "darwin" && existsSync("/Volumes")) {
    return "/Volumes";
  }
  return app.getPath("downloads");
}

async function walkPath(rootPath: string, basePath: string, output: string[]) {
  const details = await stat(rootPath);
  if (details.isDirectory()) {
    const entries = await readdir(rootPath, { withFileTypes: true });
    for (const entry of entries) {
      await walkPath(path.join(rootPath, entry.name), basePath, output);
    }
    return;
  }

  if (/\.dat$/i.test(rootPath)) {
    output.push(path.relative(basePath, rootPath));
  }
}

async function collectDatPaths(selectionPaths: string[]) {
  const files: Array<{ absolutePath: string; relativePath: string }> = [];

  for (const selectionPath of selectionPaths) {
    const details = await stat(selectionPath);
    if (details.isDirectory()) {
      const discovered: string[] = [];
      await walkPath(selectionPath, selectionPath, discovered);
      for (const relativePath of discovered) {
        files.push({
          absolutePath: path.join(selectionPath, relativePath),
          relativePath,
        });
      }
      continue;
    }

    if (/\.dat$/i.test(selectionPath)) {
      files.push({
        absolutePath: selectionPath,
        relativePath: path.basename(selectionPath),
      });
    }
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function nextAvailablePath(targetDirectory: string, baseName: string) {
  const parsed = path.parse(baseName);
  let attempt = 0;

  while (true) {
    const candidateName =
      attempt === 0
        ? `${parsed.name}${parsed.ext}`
        : `${parsed.name}-${attempt}${parsed.ext}`;
    const candidate = path.join(targetDirectory, candidateName);
    if (!existsSync(candidate)) {
      return candidate;
    }
    attempt += 1;
  }
}

function sliceArrayBuffer(source: Buffer<ArrayBufferLike>) {
  return Uint8Array.from(source).buffer;
}

async function prepareImportedPhotos(
  datPaths: Array<{ absolutePath: string; relativePath: string }>,
  ingestMode: IngestMode,
) {
  let sourceFiles = datPaths;

  if (ingestMode === "copy" && datPaths.length > 0) {
    const targetSelection = await dialog.showOpenDialog({
      title: "Choose where to copy the imported DAT files",
      defaultPath: app.getPath("documents"),
      properties: ["openDirectory", "createDirectory"],
    });

    if (targetSelection.canceled || targetSelection.filePaths.length === 0) {
      return [];
    }

    const destinationRoot = targetSelection.filePaths[0];
    const copied: Array<{ absolutePath: string; relativePath: string }> = [];

    for (const item of datPaths) {
      const targetDatPath = await nextAvailablePath(destinationRoot, path.basename(item.absolutePath));
      await copyFile(item.absolutePath, targetDatPath);

      const sidecarPath = `${item.absolutePath}.json`;
      if (existsSync(sidecarPath)) {
        await copyFile(sidecarPath, `${targetDatPath}.json`);
      }

      copied.push({
        absolutePath: targetDatPath,
        relativePath: path.basename(targetDatPath),
      });
    }

    sourceFiles = copied;
  }

  const imported: ImportedPhotoPayload[] = [];
  for (const item of sourceFiles) {
    const bytes = await readFile(item.absolutePath);
    const sidecarPath = `${item.absolutePath}.json`;
    const sidecarText = existsSync(sidecarPath) ? await readFile(sidecarPath, "utf8") : null;
    imported.push({
      name: path.basename(item.absolutePath),
      filePath: item.absolutePath,
      relativePath: item.relativePath,
      ingestMode,
      bytes: sliceArrayBuffer(bytes),
      sidecarText,
      sidecarPath: existsSync(sidecarPath) ? sidecarPath : null,
    });
  }

  return imported;
}

async function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    autoHideMenuBar: true,
    title: "DJ1000 Converter Web",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await window.loadURL(devServerUrl);
    window.webContents.openDevTools({ mode: "detach" });
    return window;
  }

  await window.loadFile(path.join(__dirname, "../dist/index.html"));
  return window;
}

ipcMain.handle("desktop:pick-import", async (_event, payload: PickImportRequest) => {
  const selection = await dialog.showOpenDialog({
    title: payload.kind === "folder" ? "Open folder of DAT files" : "Open DAT files",
    defaultPath: getImportDefaultPath(),
    filters: [
      { name: "DJ1000 DAT files", extensions: ["dat"] },
      { name: "All files", extensions: ["*"] },
    ],
    properties:
      payload.kind === "folder"
        ? ["openDirectory", "createDirectory"]
        : ["openFile", "multiSelections"],
  });

  if (selection.canceled || selection.filePaths.length === 0) {
    return { entries: [] };
  }

  const datPaths = await collectDatPaths(selection.filePaths);
  const entries = await prepareImportedPhotos(datPaths, payload.ingestMode);
  return { entries };
});

ipcMain.handle("desktop:persist-sidecar", async (_event, payload: PersistSidecarRequest) => {
  const sidecarPath = `${payload.filePath}.json`;
  await writeFile(sidecarPath, payload.sidecarText, "utf8");
  return { sidecarPath };
});

ipcMain.handle("desktop:export-files", async (_event, payload: ExportFilesRequest) => {
  if (payload.files.length === 0) {
    return { written: 0 };
  }

  if (payload.files.length === 1) {
    const file = payload.files[0];
    const target = await dialog.showSaveDialog({
      title: "Export converted photo",
      defaultPath: path.join(app.getPath("downloads"), path.basename(file.relativePath)),
    });

    if (target.canceled || !target.filePath) {
      return { written: 0 };
    }

    await writeFile(target.filePath, Buffer.from(file.bytes));
    return { written: 1 };
  }

  const folder = await dialog.showOpenDialog({
    title: "Choose export folder",
    defaultPath: path.join(app.getPath("downloads"), payload.suggestedFolderName),
    properties: ["openDirectory", "createDirectory"],
  });

  if (folder.canceled || folder.filePaths.length === 0) {
    return { written: 0 };
  }

  const root = folder.filePaths[0];
  let written = 0;
  for (const file of payload.files) {
    const outputPath = path.join(root, file.relativePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(file.bytes));
    written += 1;
  }

  return { written };
});

app.whenReady().then(async () => {
  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
