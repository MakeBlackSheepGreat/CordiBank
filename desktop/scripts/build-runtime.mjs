#!/usr/bin/env node
/**
 * 编译 runtime：TypeScript 源码转成可随包发布的 JavaScript。
 *
 * 复用 runtime 自带的 tsconfig，产物落在 runtime/dist，由 electron-builder 作为额外资源收进安装包。
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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

/**
 * 实体化生产依赖到 runtime/pack-deps。
 *
 * electron-builder 会原样复制 node_modules 里的符号链接；pnpm 布局下这些链接
 * 指向 .pnpm store，复制进安装包后全部悬空。这里把生产依赖闭包按 realpath
 * 解析后复制为真实目录，extraResources 只收 staging 目录，与包管理器布局解耦。
 */
const requireFromRuntime = createRequire(path.join(runtimeDir, "package.json"));
const packDepsDir = path.join(runtimeDir, "pack-deps");
rmSync(packDepsDir, { recursive: true, force: true });
mkdirSync(packDepsDir, { recursive: true });

const staged = new Set();
const pending = Object.keys(
  JSON.parse(readFileSync(path.join(runtimeDir, "package.json"), "utf8")).dependencies ?? {},
);

// 从入口文件逐级向上找包目录，避开部分包不导出 ./package.json 的问题
function packageDirOf(name) {
  const entry = requireFromRuntime.resolve(name);
  let dir = path.dirname(entry);
  while (path.dirname(dir) !== dir) {
    const manifest = path.join(dir, "package.json");
    if (statSync(manifest, { throwIfNoEntry: false }) && JSON.parse(readFileSync(manifest, "utf8")).name === name) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`找不到依赖包目录: ${name}`);
}

while (pending.length > 0) {
  const name = pending.pop();
  if (name.startsWith("@types/") || staged.has(name)) continue;
  const source = realpathSync(packageDirOf(name));
  const target = path.join(packDepsDir, name);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  staged.add(name);
  pending.push(...Object.keys(JSON.parse(readFileSync(path.join(source, "package.json"), "utf8")).dependencies ?? {}));
}

console.log(`[build:runtime] 实体化依赖 ${[...staged].join(", ")} -> ${path.relative(path.join(here, "..", ".."), packDepsDir)}`);

console.log("[build:runtime] 完成");
