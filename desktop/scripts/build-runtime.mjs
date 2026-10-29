#!/usr/bin/env node
/**
 * 编译 runtime：TypeScript 源码转成可随包发布的 JavaScript。
 *
 * 复用 runtime 自带的 tsconfig，产物落在 runtime/dist，由 electron-builder 作为额外资源收进安装包。
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.join(here, "..", "..", "runtime");

console.log("[build:runtime] 编译 TypeScript 源码");
const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsc", "-p", "tsconfig.json"],
  { cwd: runtimeDir, stdio: "inherit", shell: process.platform === "win32" },
);

if (result.status !== 0) {
  console.error("[build:runtime] 编译失败");
  process.exit(result.status ?? 1);
}

/**
 * 把 package.json 复制到编译产物目录。
 *
 * 编译产物是 ESM，缺少 "type": "module" 声明时 Node 会按 CommonJS 解析，
 * 加载即报 import 语法错误。桌面应用从随包资源加载 runtime，必须带上这个声明。
 */
const distDir = path.join(runtimeDir, "dist");
mkdirSync(distDir, { recursive: true });
copyFileSync(path.join(runtimeDir, "package.json"), path.join(distDir, "package.json"));

console.log("[build:runtime] 完成");
