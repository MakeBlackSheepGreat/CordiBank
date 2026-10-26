#!/usr/bin/env node
// MCP 自检：逐个拉起三个银行外部服务，跑 initialize、tools/list 与一次工具调用。
// 用法：node mcp/selftest.mjs

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 单个服务器的探针：返回可用工具名与一次调用结果。 */
function probe(file, toolName, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, file)], { stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: child.stdout });
    const pending = new Map();
    let nextId = 1;

    const send = (method, params) =>
      new Promise((done, fail) => {
        const id = nextId++;
        pending.set(id, { done, fail });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            fail(new Error(`${file} 超时：${method}`));
          }
        }, 8000);
      });

    rl.on("line", (line) => {
      if (line.trim() === "") return;
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) entry.fail(new Error(message.error.message));
      else entry.done(message.result);
    });

    child.on("error", reject);

    void (async () => {
      try {
        const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
        const listed = await send("tools/list", {});
        const names = listed.tools.map((item) => item.name);
        if (!names.includes(toolName)) throw new Error(`${file} 未暴露工具 ${toolName}`);
        const called = await send("tools/call", { name: toolName, arguments: args });
        const text = called.content?.[0]?.text ?? "";
        resolve({ server: init.serverInfo.name, tools: names, sample: JSON.parse(text) });
      } catch (error) {
        reject(error);
      } finally {
        child.stdin.end();
        child.kill();
      }
    })();
  });
}

const targets = [
  ["fx-server.mjs", "convert", { amount: 100, base: "USD", quote: "CNY" }],
  ["risk-server.mjs", "screen_payee", { name: "王晓明", account: "6222020200111234", amountCents: 80000 }],
  ["catalog-server.mjs", "suitability", { productId: "p-005", customerRiskLevel: 2, amountCents: 5000000 }],
  ["gift-server.mjs", "place_order", { giftId: "gift-combo", deliverDate: "2026-11-08" }],
];

for (const [file, tool, args] of targets) {
  const result = await probe(file, tool, args);
  console.log(`[ok] ${result.server} 工具 ${result.tools.length} 个：${result.tools.join("、")}`);
  console.log(`     样例 ${tool}：${JSON.stringify(result.sample)}`);
}
