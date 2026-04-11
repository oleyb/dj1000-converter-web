import { copyFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const distDir = path.resolve(process.cwd(), "dist");
const indexHtml = path.join(distDir, "index.html");
const fallbackHtml = path.join(distDir, "404.html");

await access(indexHtml);
await copyFile(indexHtml, fallbackHtml);

console.log("Copied dist/index.html to dist/404.html for GitHub Pages SPA fallback.");
