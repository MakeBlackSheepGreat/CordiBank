"use strict";

/**
 * MCP 子进程引导脚本。
 *
 * 打包版 Electron 在 ELECTRON_RUN_AS_NODE=1 下会把 argv 里的第一个脚本当作入口执行，
 * 不会加载 main.cjs。本脚本负责清掉宿主注入的 Node 变量，再把真正的 MCP 服务跑起来。
 *
 * 用法：electron.exe <引导脚本> <MCP 服务路径>
 */

const path = require("node:path");
const fs = require("node:fs");

// 打包版 Electron 不支持 NODE_OPTIONS，带着它会直接报错退出。
delete process.env.NODE_OPTIONS;

const target = process.argv[2];
if (!target) {
  process.stderr.write("缺少 MCP 服务路径\n");
  process.exit(2);
}

const resolved = path.resolve(target);
if (!fs.existsSync(resolved)) {
  process.stderr.write(`找不到 MCP 服务：${resolved}\n`);
  process.exit(2);
}

// MCP 服务是 ESM，用动态导入加载。
import(pathToFileURL(resolved).href).catch((error) => {
  process.stderr.write(`MCP 服务加载失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

function pathToFileURL(filePath) {
  const { pathToFileURL: toUrl } = require("node:url");
  return toUrl(filePath);
}
