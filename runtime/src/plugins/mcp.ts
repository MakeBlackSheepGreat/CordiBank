import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { RuntimeConfig } from "../config.ts";
import type { CapabilityPlugin, Provider } from "../capabilities/types.ts";
import { readJsonFile, writeJsonAtomic } from "../shared/json-store.ts";
import { redactText } from "../core/redact.ts";
import { RuntimeError } from "../core/errors.ts";
import { shortId } from "../shared/ids.ts";

/**
 * MCP 客户端能力 "mcp"：把外部 MCP 服务器的工具接进运行时。
 *
 * - 服务器清单持久化在 <storeDir>/mcp.json（CORDISWARM_MCP_FILE 可覆盖），
 *   增删都走原子写回。
 * - stdio 传输按行分帧 JSON-RPC，http 传输按 Streamable HTTP 收发，
 *   SSE 响应解析 data: 行。
 * - 握手固定为 initialize → notifications/initialized → tools/list；工具清单
 *   始终来自服务器真实响应，服务器不可达或协议异常一律结构化报错。
 * - 每个服务器缓存一条连接；任何一次交互失败都会销毁该连接（stdio 子进程随之
 *   结束），卸载插件时关闭全部连接。
 */

/** 单次 JSON-RPC 往返的默认超时。 */
const DEFAULT_TIMEOUT_MS = 15_000;
/** 客户端声明的 MCP 协议版本。 */
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "cordiswarm", version: "0.1.0" };
/** stdio 单帧与整体缓冲上限；stderr 诊断片段上限。 */
const FRAME_LIMIT = 4 * 1024 * 1024;
const STDERR_LIMIT = 4 * 1024;
const NOISE_LIMIT = 1 * 1024;
/** 错误信息里回显服务器原文的长度上限。 */
const PREVIEW_LIMIT = 500;
/** 终止子进程的宽限时间。 */
const KILL_GRACE_MS = 500;
/** 服务器 id 允许的字符。 */
const SERVER_ID = /^[a-zA-Z0-9._-]+$/;

export type McpTransportKind = "stdio" | "http";

/** 一个已配置的 MCP 服务器。 */
export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransportKind;
  /** stdio 传输的可执行文件。 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http 传输的 JSON-RPC 端点。 */
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 连接器目录分类（如 汇率 / 风控 / 产品）。 */
  category?: string;
}

/** 列表返回的服务器摘要；status 为空闲/最近一次连接结果。 */
export interface McpServerSummary {
  id: string;
  name: string;
  transport: McpTransportKind;
  target: string;
  status: "ready" | "error" | "idle";
  toolCount: number;
  category: string;
  connected: boolean;
  error?: string;
}

/** 一个来自服务器的工具定义。 */
export interface McpTool {
  serverId: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface McpTransport {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  close(): void;
}

interface McpConnection {
  transport: McpTransport;
  tools: McpTool[];
}

/** 结束子进程：先正常终止，宽限期内未退出再强制结束。 */
function killProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // 进程已退出
      }
    }
  }, KILL_GRACE_MS);
  timer.unref?.();
}

/** 服务器原文预览：脱敏后截断，仅用于错误信息。 */
function preview(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  const safe = redactText(text ?? "");
  return safe.length > PREVIEW_LIMIT ? `${safe.slice(0, PREVIEW_LIMIT)}…` : safe;
}

/** 任意异常转 RuntimeError，保留原始文案。 */
function toRuntimeError(error: unknown, fallback: string): RuntimeError {
  if (error instanceof RuntimeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RuntimeError("RESOURCE_UNAVAILABLE", message === "" ? fallback : redactText(message));
}

/** JSON-RPC 错误对象转结构化错误；无错误返回 null。 */
function jsonRpcFailure(message: unknown, method: string): RuntimeError | null {
  if (message === null || typeof message !== "object") return null;
  const error = (message as { error?: unknown }).error;
  if (error === undefined || error === null) return null;
  const detail = error as { code?: unknown; message?: unknown; data?: unknown };
  const code = typeof detail.code === "number" ? detail.code : "?";
  const text = typeof detail.message === "string" ? detail.message : preview(error);
  const data = detail.data === undefined ? "" : `：${preview(detail.data)}`;
  return new RuntimeError("RESOURCE_UNAVAILABLE", `MCP ${method} 返回错误 ${code}：${text}${data}`);
}

/** JSON-RPC 结果必须是对象。 */
function requireObject(value: unknown, method: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeError("RESOURCE_UNAVAILABLE", `MCP ${method} 响应不是对象：${preview(value)}`);
  }
  return value as Record<string, unknown>;
}

/** 工具调用结果按 MCP 规范取 content；isError 转结构化错误。 */
function readCallContent(result: unknown, tool: string): unknown[] {
  const payload = requireObject(result, "tools/call");
  const content = payload.content;
  if (!Array.isArray(content)) {
    throw new RuntimeError("RESOURCE_UNAVAILABLE", `MCP 工具 ${tool} 响应缺少 content：${preview(result)}`);
  }
  if (payload.isError === true) {
    const text = content
      .map((block) => (block !== null && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : preview(block)))
      .join("\n");
    throw new RuntimeError("RESOURCE_UNAVAILABLE", `MCP 工具 ${tool} 返回错误：${redactText(text)}`);
  }
  return content;
}

/** 从 tools/list 结果读工具清单：条目缺少 name 时按协议错误拒绝。 */
function readToolList(result: unknown, serverId: string): McpTool[] {
  const payload = requireObject(result, "tools/list");
  const list = payload.tools;
  if (!Array.isArray(list)) {
    throw new RuntimeError("RESOURCE_UNAVAILABLE", `MCP 服务器 ${serverId} 的 tools/list 缺少 tools 数组：${preview(result)}`);
  }
  return list.map((item) => {
    const tool = requireObject(item, "tools/list");
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (name === "") {
      throw new RuntimeError("RESOURCE_UNAVAILABLE", `MCP 服务器 ${serverId} 的 tools/list 条目缺少 name：${preview(item)}`);
    }
    return {
      serverId,
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.inputSchema ?? {},
    };
  });
}

/** 字符串数组字段：非法即拒绝，不做兜底猜测。 */
function readStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RuntimeError("INVALID_INPUT", `${field} 必须是字符串数组`);
  }
  return [...(value as string[])];
}

/** 字符串映射字段：非法即拒绝。 */
function readStringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeError("INVALID_INPUT", `${field} 必须是字符串映射`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new RuntimeError("INVALID_INPUT", `${field} 必须是字符串映射`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** 服务器 id 由 name 生成安全 slug。 */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
}

/** 服务器配置归一化：非法输入直接拒绝。 */
export function normalizeMcpServer(raw: unknown): McpServerConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuntimeError("INVALID_INPUT", "MCP 服务器配置必须是对象");
  }
  const input = raw as Record<string, unknown>;
  const transport: McpTransportKind | null =
    input.transport === "stdio" ? "stdio" : input.transport === "http" ? "http" : null;
  if (transport === null) {
    throw new RuntimeError("INVALID_INPUT", "transport 必须是 stdio 或 http");
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const explicitId = typeof input.id === "string" ? input.id.trim() : "";
  const id = explicitId !== "" ? explicitId : slugify(name) !== "" ? slugify(name) : shortId("mcp");
  if (!SERVER_ID.test(id)) {
    throw new RuntimeError("INVALID_INPUT", `服务器 id 只允许字母、数字与 . _ -：${id}`);
  }
  const rawTimeout = input.timeoutMs;
  const timeoutMs =
    typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.floor(rawTimeout)
      : undefined;
  const category = typeof input.category === "string" ? input.category.trim() : "";
  const base = {
    id,
    name: name === "" ? id : name,
    transport,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(category === "" ? {} : { category }),
  };
  if (transport === "stdio") {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (command === "") {
      throw new RuntimeError("INVALID_INPUT", "stdio 服务器需要非空 command");
    }
    if (/[;&|`\r\n]/.test(command) || command.split(/[\\/]/).includes("..")) {
      throw new RuntimeError("INVALID_INPUT", "stdio command 含 shell 元字符或路径穿越段，已拒绝");
    }
    const args = readStringArray(input.args, "args");
    const env = readStringMap(input.env, "env");
    return {
      ...base,
      command,
      ...(args === undefined ? {} : { args }),
      ...(env === undefined ? {} : { env }),
    };
  }
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) {
    throw new RuntimeError("INVALID_INPUT", "http 服务器需要 http(s) url");
  }
  const headers = readStringMap(input.headers, "headers");
  return { ...base, url, ...(headers === undefined ? {} : { headers }) };
}

/** 展开 secret 引用：值中的 ${ENV_NAME} 从环境变量解析，凭据不写入清单文件。 */
export function expandSecretRefs(value: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (ref, name) => {
    const resolved = process.env[name];
    if (resolved === undefined || resolved === "") {
      throw new RuntimeError("INVALID_INPUT", "环境变量未设置，无法解析凭据引用：" + name);
    }
    return resolved;
  });
}

function expandSecretMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
  if (map === undefined) return undefined;
  return Object.fromEntries(Object.entries(map).map(([key, value]) => [key, expandSecretRefs(value)]));
}

/** stdio 传输：spawn 子进程，按行分帧 JSON-RPC。 */
function createStdioTransport(server: McpServerConfig): McpTransport {
  const child = spawn(server.command ?? "", server.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...expandSecretMap(server.env) },
    windowsHide: true,
  });
  const pending = new Map<number, PendingCall>();
  let nextId = 1;
  let buffer = "";
  let stderrTail = "";
  let noise = "";
  let closed = false;

  // 服务器提前退出时 stdin 写入以 EPIPE 失败，统一交由 close 事件处理
  child.stdin?.on("error", () => undefined);

  const writeFrame = (message: Record<string, unknown>): void => {
    if (closed || !child.stdin || child.stdin.destroyed) {
      throw new RuntimeError("RESOURCE_UNAVAILABLE", "MCP 连接已关闭，无法写入请求");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  /** 传输层失败：拒绝全部待决请求、结束子进程，保证无残留进程。 */
  const fail = (reason: string): void => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new RuntimeError("RESOURCE_UNAVAILABLE", reason));
    }
    pending.clear();
    try {
      child.stdin?.end();
    } catch {
      // 进程已退出
    }
    killProcess(child);
  };

  const settle = (message: Record<string, unknown>): void => {
    const id = message.id;
    if (typeof id !== "number") return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    const failure = jsonRpcFailure(message, entry.method);
    if (failure) {
      entry.reject(failure);
      return;
    }
    entry.resolve(message.result);
  };

  const dispatch = (line: string): void => {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("非对象帧");
      message = parsed as Record<string, unknown>;
    } catch {
      // 非协议输出（服务器日志等）只留存用于诊断，不参与分帧
      noise = `${noise}${line}\n`.slice(-NOISE_LIMIT);
      return;
    }
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) {
        // 服务器发起的请求（sampling / roots 等）明确拒绝，避免对方空等
        try {
          writeFrame({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `客户端未实现：${message.method}` },
          });
        } catch {
          // 写入失败由 fail 统一处理
        }
      }
      return;
    }
    settle(message);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > FRAME_LIMIT) {
      fail(`MCP 响应超过分帧上限（${FRAME_LIMIT} 字节）`);
      return;
    }
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim() !== "") dispatch(line);
      index = buffer.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-STDERR_LIMIT);
  });
  child.on("error", (error: Error) => {
    fail(`MCP 服务器启动失败：${redactText(error.message)}`);
  });
  child.on("close", (code, signal) => {
    const detail = stderrTail.trim() === "" ? "" : `：${stderrTail.trim()}`;
    const extra = noise.trim() === "" ? "" : `（非协议输出：${noise.trim()}）`;
    fail(
      `MCP 服务器进程已退出（code=${code ?? "null"}, signal=${signal ?? "null"}）${detail}${extra}`,
    );
  });

  return {
    request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
      return new Promise<unknown>((resolve, reject) => {
        if (closed) {
          reject(new RuntimeError("RESOURCE_UNAVAILABLE", "MCP 连接已关闭"));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          fail(`MCP 请求超时（${timeoutMs}ms）：${method}`);
        }, timeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        try {
          writeFrame({ jsonrpc: "2.0", id, method, params });
        } catch (error) {
          fail(toRuntimeError(error, `MCP 请求写入失败：${method}`).message);
        }
      });
    },

    async notify(method: string, params: unknown): Promise<void> {
      if (closed) throw new RuntimeError("RESOURCE_UNAVAILABLE", "MCP 连接已关闭");
      try {
        writeFrame({ jsonrpc: "2.0", method, params });
      } catch (error) {
        fail(toRuntimeError(error, `MCP 通知写入失败：${method}`).message);
      }
    },

    close(): void {
      if (closed) return;
      closed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new RuntimeError("RESOURCE_UNAVAILABLE", "MCP 连接已关闭"));
      }
      pending.clear();
      try {
        child.stdin?.end();
      } catch {
        // 进程已退出
      }
      killProcess(child);
    },
  };
}

/** SSE 事件切分：按空行分帧，返回完整事件与残余缓冲。 */
function drainSse(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer;
  for (;;) {
    const match = /\r?\n\r?\n/.exec(rest);
    if (!match || match.index === undefined) break;
    events.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  return { events, rest };
}

/** 单个 SSE 事件的 data 负载。 */
function ssePayload(event: string): string {
  return event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
}

/** http 传输：POST JSON-RPC，响应可能是 JSON 或 SSE 流。 */
function createHttpTransport(server: McpServerConfig): McpTransport {
  const url = server.url ?? "";
  const inflight = new Set<AbortController>();
  let nextId = 1;
  let sessionId: string | null = null;
  let closed = false;

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    ...expandSecretMap(server.headers),
    ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
  });

  /** 读取 SSE 响应：取同 id 的最后一个结果；流结束时仍未出现即报错。 */
  const readSse = async (response: Response, id: number, method: string): Promise<unknown> => {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new RuntimeError("RESOURCE_UNAVAILABLE", `MCP SSE 响应没有正文：${method}`);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let settled: { found: true; value: unknown } | { found: false } = { found: false };
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const { events, rest } = drainSse(buffer);
        buffer = rest;
        for (const event of events) {
          const payload = ssePayload(event);
          if (payload === "") continue;
          let message: Record<string, unknown>;
          try {
            const parsed = JSON.parse(payload) as unknown;
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
            message = parsed as Record<string, unknown>;
          } catch {
            continue;
          }
          if (message.id !== id) continue;
          const failure = jsonRpcFailure(message, method);
          if (failure) throw failure;
          // 同一批事件里取最后一个结果
          settled = { found: true, value: message.result };
        }
        if (settled.found) {
          await reader.cancel().catch(() => undefined);
          return settled.value;
        }
      }
    } finally {
      reader.releaseLock();
    }
    throw new RuntimeError(
      "RESOURCE_UNAVAILABLE",
      `MCP SSE 流未返回 id=${id} 的响应（${method}）：${preview(buffer)}`,
    );
  };

  const send = async (message: Record<string, unknown>, timeoutMs: number, expectReply: boolean): Promise<unknown> => {
    if (closed) throw new RuntimeError("RESOURCE_UNAVAILABLE", "MCP 连接已关闭");
    const method = typeof message.method === "string" ? message.method : "响应";
    const id = typeof message.id === "number" ? message.id : null;
    const controller = new AbortController();
    inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const negotiated = response.headers.get("mcp-session-id");
      if (negotiated !== null && negotiated !== "") sessionId = negotiated;
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new RuntimeError(
          "RESOURCE_UNAVAILABLE",
          `MCP HTTP ${response.status} ${response.statusText}（${method}）${body === "" ? "" : `：${preview(body)}`}`,
        );
      }
      if (!expectReply) {
        await response.text().catch(() => "");
        return null;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        if (id === null) throw new RuntimeError("RESOURCE_UNAVAILABLE", `MCP SSE 响应缺少请求 id：${method}`);
        return await readSse(response, id, method);
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new RuntimeError("RESOURCE_UNAVAILABLE", `MCP 响应不是 JSON（${method}）：${preview(text)}`);
      }
      const failure = jsonRpcFailure(parsed, method);
      if (failure) throw failure;
      return requireObject(parsed, method).result;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      if (controller.signal.aborted) {
        throw new RuntimeError("RESOURCE_UNAVAILABLE", `MCP 请求超时（${timeoutMs}ms）：${method}`);
      }
      const message2 = error instanceof Error ? error.message : String(error);
      throw new RuntimeError("RESOURCE_UNAVAILABLE", `MCP HTTP 请求失败（${method}）：${redactText(message2)}`);
    } finally {
      clearTimeout(timer);
      inflight.delete(controller);
    }
  };

  return {
    request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
      return send({ jsonrpc: "2.0", id: nextId++, method, params }, timeoutMs, true);
    },

    async notify(method: string, params: unknown): Promise<void> {
      await send({ jsonrpc: "2.0", method, params }, DEFAULT_TIMEOUT_MS, false);
    },

    close(): void {
      closed = true;
      for (const controller of inflight) controller.abort();
      inflight.clear();
    },
  };
}

/** MCP 客户端能力 "mcp"。 */
export function createMcpPlugin(cfg: RuntimeConfig): CapabilityPlugin {
  /** 服务器清单文件：默认在运行时 store 下，CORDISWARM_MCP_FILE 覆盖。 */
  const configFile = (): string =>
    process.env.CORDISWARM_MCP_FILE?.trim() || path.join(cfg.storeDir, "mcp.json");

  /** 已建立的连接与最近一次交互状态。 */
  const connections = new Map<string, McpConnection>();
  const status = new Map<string, { status: "ready" | "error"; toolCount: number; error?: string }>();

  /** 读取服务器清单；文件缺失或损坏按空清单处理，条目非法即报错。 */
  const readServers = (): McpServerConfig[] => {
    const raw = readJsonFile<unknown>(configFile(), null);
    if (raw === null || raw === undefined) return [];
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new RuntimeError("INVALID_INPUT", `MCP 配置格式无效：${configFile()}`);
    }
    const list = (raw as { servers?: unknown }).servers;
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) {
      throw new RuntimeError("INVALID_INPUT", `MCP 配置缺少 servers 数组：${configFile()}`);
    }
    return list.map((item, index) => {
      try {
        return normalizeMcpServer(item);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new RuntimeError("INVALID_INPUT", `MCP 配置第 ${index + 1} 条无效：${message}`);
      }
    });
  };

  /** 原子写回服务器清单。 */
  const writeServers = (servers: McpServerConfig[]): void => {
    writeJsonAtomic(configFile(), { servers });
  };

  const requireServer = (servers: McpServerConfig[], serverId: unknown): McpServerConfig => {
    if (typeof serverId !== "string" || serverId.trim() === "") {
      throw new RuntimeError("INVALID_INPUT", "MCP 服务器操作需要 serverId");
    }
    const id = serverId.trim();
    const server = servers.find((item) => item.id === id);
    if (!server) throw new RuntimeError("NOT_FOUND", `MCP 服务器未配置：${id}`);
    return server;
  };

  const targetOf = (server: McpServerConfig): string =>
    server.transport === "stdio"
      ? [server.command ?? "", ...(server.args ?? [])].join(" ").trim()
      : server.url ?? "";

  const summarize = (server: McpServerConfig): McpServerSummary => {
    const state = status.get(server.id);
    return {
      id: server.id,
      name: server.name,
      transport: server.transport,
      target: targetOf(server),
      status: state?.status ?? "idle",
      toolCount: state?.toolCount ?? 0,
      category: server.category ?? "",
      connected: connections.has(server.id),
      ...(state?.status === "error" && state.error !== undefined ? { error: state.error } : {}),
    };
  };

  /** 销毁连接：stdio 子进程随之结束。 */
  const destroyConnection = (serverId: string): void => {
    const connection = connections.get(serverId);
    if (!connection) return;
    connections.delete(serverId);
    connection.transport.close();
  };

  /** 统一的失败出口：销毁连接、记录错误状态并抛出结构化错误。 */
  const failOn = (server: McpServerConfig, error: unknown): never => {
    destroyConnection(server.id);
    const failure = toRuntimeError(error, `MCP 服务器 ${server.id} 交互失败`);
    status.set(server.id, { status: "error", toolCount: 0, error: failure.message });
    throw failure;
  };

  /** 在连接上列举工具。 */
  const listTools = async (transport: McpTransport, server: McpServerConfig): Promise<McpTool[]> => {
    const result = await transport.request("tools/list", {}, server.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return readToolList(result, server.id);
  };

  /** 建立连接：initialize → notifications/initialized → tools/list。 */
  const ensureConnection = async (server: McpServerConfig): Promise<McpConnection> => {
    const cached = connections.get(server.id);
    if (cached) return cached;
    const timeoutMs = server.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const transport =
      server.transport === "stdio" ? createStdioTransport(server) : createHttpTransport(server);
    try {
      await transport.request(
        "initialize",
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
        timeoutMs,
      );
      await transport.notify("notifications/initialized", {});
      const tools = await listTools(transport, server);
      const connection: McpConnection = { transport, tools };
      connections.set(server.id, connection);
      status.set(server.id, { status: "ready", toolCount: tools.length });
      return connection;
    } catch (error) {
      transport.close();
      return failOn(server, error);
    }
  };

  /** 连接上执行动作；任何失败都会销毁连接并记录错误状态。 */
  const runOn = async <T>(
    server: McpServerConfig,
    action: (connection: McpConnection) => Promise<T>,
  ): Promise<T> => {
    const connection = await ensureConnection(server);
    try {
      return await action(connection);
    } catch (error) {
      return failOn(server, error);
    }
  };

  /** 工具清单：未连接时握手列举，已连接时重新列举保持新鲜。 */
  const loadTools = async (server: McpServerConfig): Promise<McpTool[]> => {
    const cached = connections.get(server.id);
    if (!cached) return (await ensureConnection(server)).tools;
    try {
      const tools = await listTools(cached.transport, server);
      cached.tools = tools;
      status.set(server.id, { status: "ready", toolCount: tools.length });
      return tools;
    } catch (error) {
      return failOn(server, error);
    }
  };

  const provider: Provider = {
    /** 已配置服务器清单；status 反映最近一次交互结果，未交互为 idle。 */
    list(): { servers: McpServerSummary[] } {
      return { servers: readServers().map(summarize) };
    },

    /** 新增服务器并原子写回清单。 */
    add(input: unknown): { servers: McpServerSummary[] } {
      const server = normalizeMcpServer(input);
      const servers = readServers();
      if (servers.some((item) => item.id === server.id)) {
        throw new RuntimeError("INVALID_INPUT", `MCP 服务器已存在：${server.id}`);
      }
      servers.push(server);
      writeServers(servers);
      return { servers: servers.map(summarize) };
    },

    /** 删除服务器并原子写回清单；其连接一并销毁。 */
    remove(serverId: unknown): { servers: McpServerSummary[] } {
      const servers = readServers();
      const server = requireServer(servers, serverId);
      destroyConnection(server.id);
      status.delete(server.id);
      const remaining = servers.filter((item) => item.id !== server.id);
      writeServers(remaining);
      return { servers: remaining.map(summarize) };
    },

    /** 主动建立连接并刷新工具清单；失败时状态记为 error 并抛出。 */
    async connect(serverId: unknown): Promise<{ servers: McpServerSummary[] }> {
      const server = requireServer(readServers(), serverId);
      await loadTools(server);
      return { servers: readServers().map(summarize) };
    },

    /** 断开连接：连接销毁，状态回到 idle；清单保留。 */
    disconnect(serverId: unknown): { servers: McpServerSummary[] } {
      const server = requireServer(readServers(), serverId);
      destroyConnection(server.id);
      status.delete(server.id);
      return { servers: readServers().map(summarize) };
    },

    /** 健康检查：重列工具并计时；失败返回 ok:false 而不抛出。 */
    async health(serverId: unknown): Promise<{ id: string; ok: boolean; latencyMs: number; toolCount?: number; error?: string }> {
      const server = requireServer(readServers(), serverId);
      const started = Date.now();
      try {
        const connection = await ensureConnection(server);
        const tools = await listTools(connection.transport, server);
        connection.tools = tools;
        status.set(server.id, { status: "ready", toolCount: tools.length });
        return { id: server.id, ok: true, latencyMs: Date.now() - started, toolCount: tools.length };
      } catch (error) {
        destroyConnection(server.id);
        const failure = toRuntimeError(error, "MCP 服务器 " + server.id + " 健康检查失败");
        status.set(server.id, { status: "error", toolCount: 0, error: failure.message });
        return { id: server.id, ok: false, latencyMs: Date.now() - started, error: failure.message };
      }
    },
    /** 列举工具：给出 serverId 只列举该服务器，否则列举全部已配置服务器。 */
    async tools(serverId?: unknown): Promise<{ tools: McpTool[] }> {
      const servers = readServers();
      const targets =
        serverId === undefined || serverId === null || serverId === ""
          ? servers
          : [requireServer(servers, serverId)];
      const tools: McpTool[] = [];
      for (const server of targets) {
        tools.push(...(await loadTools(server)));
      }
      return { tools };
    },

    /** 调用工具：结果按 MCP 规范取 content 块。 */
    async call(serverId: unknown, tool: unknown, args: unknown): Promise<{ result: unknown[] }> {
      const server = requireServer(readServers(), serverId);
      if (typeof tool !== "string" || tool.trim() === "") {
        throw new RuntimeError("INVALID_INPUT", "MCP 工具调用需要非空 tool");
      }
      const name = tool.trim();
      return await runOn(server, async (connection) => {
        const result = await connection.transport.request(
          "tools/call",
          { name, arguments: args ?? {} },
          server.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
        return { result: readCallContent(result, name) };
      });
    },
  };

  return {
    name: "mcp",
    def: {
      service: "mcp.client",
      methods: ["list", "add", "remove", "connect", "disconnect", "health", "tools", "call"],
      description: "MCP 连接器中心：多连接管理（connect/disconnect/health）、目录元数据与工具调用",
    },
    provider,
    unmount(): void {
      for (const serverId of [...connections.keys()]) destroyConnection(serverId);
      status.clear();
    },
  };
}

export default createMcpPlugin;
