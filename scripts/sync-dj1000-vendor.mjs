import { copyFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const appRoot = process.cwd();
const libraryRoot = process.env.DJ1000_LIB_DIR
  ? path.resolve(appRoot, process.env.DJ1000_LIB_DIR)
  : path.resolve(appRoot, "../dj1000-converter-lib");
const wasmBuildDir = path.join(libraryRoot, "build-wasm", "native");
const targetDir = path.join(appRoot, "public", "vendor", "dj1000");

const requiredFiles = [
  "dj1000_wasm.mjs",
  "dj1000_wasm.wasm",
  "dj1000_wasm_api.mjs",
];

async function ensureExists(filePath) {
  try {
    await access(filePath);
  } catch {
    throw new Error(
      [
        `Missing required file: ${filePath}`,
        "",
        "Build the sibling dj1000-converter-lib WASM target first:",
        "  emcmake cmake -S ../dj1000-converter-lib -B ../dj1000-converter-lib/build-wasm -G Ninja -DDJ1000_BUILD_WASM=ON -DDJ1000_BUILD_CLI=OFF -DDJ1000_BUILD_TESTS=OFF",
        "  cmake --build ../dj1000-converter-lib/build-wasm --target dj1000_wasm",
      ].join("\n"),
    );
  }
}

await mkdir(targetDir, { recursive: true });

for (const fileName of requiredFiles) {
  const source = path.join(wasmBuildDir, fileName);
  const target = path.join(targetDir, fileName);
  await ensureExists(source);
  await copyFile(source, target);
}

console.log(`Synced dj1000 WASM vendor bundle from ${wasmBuildDir}`);
