#!/usr/bin/env node
// 零依赖 MCP 服务端骨架：按行分帧 JSON-RPC 2.0，实现 initialize、tools/list、tools/call。
// 三个银行外部服务（汇率、风控、产品）共用这一份协议处理，业务逻辑放在各自入口文件。

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";

/** 写一条响应；stdout 只承载协议消息，日志一律走 stderr。 */
function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * 启动服务端。
 * @param {{ name: string, version: string, tools: Array<{name: string, description: string, inputSchema: object, handler: (args: object) => object}> }} options
 */
export function runServer(options) {
  const toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", async (line) => {
    const text = line.trim();
    if (text === "") return;
    let request;
    try {
      request = JSON.parse(text);
    } catch {
      fail(null, -32700, "JSON 解析失败");
      return;
    }
    const { id, method, params } = request;

    if (method === "initialize") {
      write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, version: options.version },
        },
      });
      return;
    }

    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return;
    }

    if (method === "ping") {
      write({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      write({
        jsonrpc: "2.0",
        id,
        result: {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      });
      return;
    }

    if (method === "tools/call") {
      const name = params?.name;
      const tool = toolMap.get(name);
      if (tool === undefined) {
        fail(id, -32602, `未知工具：${String(name)}`);
        return;
      }
      try {
        const output = await tool.handler(params?.arguments ?? {});
        write({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] },
        });
      } catch (error) {
        write({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: String(error?.message ?? error) }],
            isError: true,
          },
        });
      }
      return;
    }

    fail(id, -32601, `不支持的方法：${String(method)}`);
  });

  rl.on("close", () => process.exit(0));
}
