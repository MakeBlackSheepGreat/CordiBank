#!/usr/bin/env node
/**
 * 构建前端：调用 web 目录的 vite build，产物落在 web/dist。
 *
 * 基路径设为相对路径，打包后从 http://127.0.0.1:<port>/ 加载时资源路径依然正确。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..", "..", "web");

console.log("[build:web] 构建前端产物");
const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vite", "build"],
  { cwd: webDir, stdio: "inherit", shell: process.platform === "win32" },
);

if (result.status !== 0) {
  console.error("[build:web] 构建失败");
  process.exit(result.status ?? 1);
}
console.log("[build:web] 完成");
