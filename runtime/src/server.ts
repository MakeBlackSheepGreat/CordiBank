import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { hasWebBuild, loadConfig, type RuntimeConfig } from "./config.ts";
import { Kernel, type KernelContext } from "./kernel.ts";
import { CapabilityRegistry } from "./capabilities/registry.ts";
import { registerBuiltinCapabilities } from "./capabilities/builtins.ts";
import { RuntimeError } from "./core/errors.ts";
import { redactText } from "./core/redact.ts";
import { writeJsonAtomic } from "./shared/json-store.ts";

/** 单次请求体上限：银行对话与审计查询都不该超过 4 MB。 */
const BODY_LIMIT = 4 * 1024 * 1024;

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new RuntimeError("INVALID_INPUT", "请求体超过上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function serveStatic(cfg: RuntimeConfig, pathname: string, res: ServerResponse): void {
  if (!hasWebBuild(cfg)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("前端尚未构建：先在 web 目录执行 npm run build");
    return;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(cfg.webDistDir, relative);
  const root = path.resolve(cfg.webDistDir);
  if (!target.startsWith(root)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  const file = existsSync(target) && statSync(target).isFile() ? target : path.join(root, "index.html");
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "content-type": STATIC_MIME[ext] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

/** 把预置 MCP 清单写入运行时 store，仅在目标文件缺失时执行。 */
function seedMcpServers(cfg: RuntimeConfig): void {
  const target = path.join(cfg.storeDir, "mcp.json");
  if (existsSync(target)) return;
  if (!existsSync(cfg.mcpPresetFile)) return;
  const mcpDir = path.dirname(path.resolve(cfg.mcpPresetFile)).split(path.sep).join("/");
  const raw = readFileSync(cfg.mcpPresetFile, "utf8").split("__MCP_DIR__").join(mcpDir);
  const parsed = JSON.parse(raw) as unknown;
  mkdirSync(cfg.storeDir, { recursive: true });
  writeJsonAtomic(target, parsed);
}

interface RpcContext {
  cfg: RuntimeConfig;
  registry: CapabilityRegistry;
  ctx: KernelContext;
  port: number;
}

/** RPC 路由：内置方法先命中，其余按 "service.method" 转发给能力插件。 */
async function route(runtime: RpcContext, method: string, params: unknown): Promise<unknown> {
  const { registry, ctx } = runtime;
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "runtime.status":
      return {
        service: "cordibank",
        version: "1.0.0",
        port: runtime.port,
        mounted: registry.list(),
        registered: registry.describe().map((capability) => ({
          name: capability.name,
          service: capability.def.service,
          methods: capability.def.methods,
          description: capability.def.description ?? "",
        })),
      };

    case "capability.list":
      return { capabilities: registry.describe(), mounted: registry.list() };

    case "capability.mount": {
      const name = typeof p.name === "string" ? p.name : "";
      if (name === "") throw new RuntimeError("INVALID_INPUT", "capability.mount 需要 name");
      if (!registry.isMounted(name)) await registry.mount(name, ctx);
      return { mounted: registry.list() };
    }

    case "capability.unmount": {
      const name = typeof p.name === "string" ? p.name : "";
      if (name === "") throw new RuntimeError("INVALID_INPUT", "capability.unmount 需要 name");
      if (registry.isMounted(name)) await registry.unmount(name);
      return { mounted: registry.list() };
    }

    default: {
      await registry.ensureServiceMounted(method, ctx);
      return registry.call(method, Array.isArray(params) ? params : []);
    }
  }
}

/** 启动 HTTP 服务：同源提供 RPC 与前端静态资源。 */
export async function startServer(options: { port?: number; cfg?: RuntimeConfig } = {}): Promise<ServerHandle> {
  const cfg = options.cfg ?? loadConfig();
  mkdirSync(cfg.storeDir, { recursive: true });
  seedMcpServers(cfg);

  const kernel = new Kernel();
  const registry = new CapabilityRegistry();
  registerBuiltinCapabilities(registry, cfg);

  const runtime: RpcContext = { cfg, registry, ctx: kernel.ctx, port: options.port ?? cfg.rpcPort };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok", service: "cordibank", port: runtime.port });
      return;
    }
    if (req.method === "POST" && url.pathname === "/rpc") {
      try {
        const raw = await readBody(req);
        const payload = JSON.parse(raw) as { method?: unknown; params?: unknown };
        const method = typeof payload.method === "string" ? payload.method : "";
        if (method === "") throw new RuntimeError("INVALID_INPUT", "缺少 method");
        const result = await route(runtime, method, payload.params);
        sendJson(res, 200, { ok: true, result });
      } catch (error) {
        if (error instanceof RuntimeError) {
          sendJson(res, 200, { ok: false, error: error.message, code: error.code });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 200, { ok: false, error: redactText(message) });
      }
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(cfg, url.pathname, res);
      return;
    }
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("method not allowed");
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtime.port, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : runtime.port);
    });
  });
  runtime.port = port;

  return {
    port,
    async close() {
      kernel.ctx.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const isMainModule =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"));

if (isMainModule) {
  startServer()
    .then((handle) => {
      console.log(`[cordibank] listening on http://127.0.0.1:${handle.port}`);
    })
    .catch((error: unknown) => {
      console.error("[cordibank] 启动失败：", error);
      process.exitCode = 1;
    });
}

export default startServer;
