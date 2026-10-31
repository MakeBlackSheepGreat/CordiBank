import type { ToolDescriptor } from "../harness/types.ts";
import type { RuntimeConfig } from "../config.ts";

export const WEB_SEARCH_TOOL = "web_search";
export const WEB_FETCH_TOOL = "web_fetch";

const FETCH_TIMEOUT_MS = 15_000;
/** 抓取正文上限：先限响应体，再限抽取后的摘要。 */
const FETCH_BODY_LIMIT = 512 * 1024;
const FETCH_SUMMARY_LIMIT = 6000;
/** DeepSeek Search & Fetch API 默认基址（对齐 DSH dsh-web-deepseek-api）；可用 DEEPSEEK_SEARCH_BASE_URL 覆盖。 */
const DEEPSEEK_TOOLS_BASE_URL = "https://api.deepseek.com/v1/tools";
const SEARCH_RESULT_COUNT = 5;

/** 免费搜索后端：复用 DeepSeek API key 直连 Search API，无需第三方搜索服务。 */
function deepseekToolsBase(): string {
  return process.env.DEEPSEEK_SEARCH_BASE_URL?.trim() || DEEPSEEK_TOOLS_BASE_URL;
}

function deepseekSearchAvailable(cfg: RuntimeConfig): boolean {
  return cfg.llm.apiKey !== "";
}

/** 私网与环回地址拒绝抓取，防 SSRF。 */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("[::1]")) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

/** Web 只读工具描述符：开关闭合时不注册；抓取随开关注册，搜索还需已配置端点。 */
export function webToolDescriptors(cfg: RuntimeConfig): ToolDescriptor[] {
  const descriptors: ToolDescriptor[] = [];
  if (!cfg.webToolsEnabled) return descriptors;
  if (cfg.webSearchUrl !== "" || deepseekSearchAvailable(cfg)) {
    descriptors.push({
      name: WEB_SEARCH_TOOL,
      summary: "联网搜索公开资料，返回标题、链接与摘要列表",
      source: "builtin",
      scene: "cross",
      risk: { level: "green", reversible: true, write: false },
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索关键词" } },
        required: ["query"],
        additionalProperties: false,
      },
    });
  }
  descriptors.push({
    name: WEB_FETCH_TOOL,
    summary: "抓取网页正文并抽取纯文本，用于核实外部信息",
    source: "builtin",
    scene: "cross",
    risk: { level: "green", reversible: true, write: false },
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "http(s) 网页地址" } },
      required: ["url"],
      additionalProperties: false,
    },
  });
  return descriptors;
}

/** HTML 抽纯文本：去脚本样式、剥标签、还原常用实体、压白。 */
function extractText(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > FETCH_SUMMARY_LIMIT ? text.slice(0, FETCH_SUMMARY_LIMIT) + "…（已截断）" : text;
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string;
}

/** 搜索端点契约：POST {query,count} → {results:[{title,url,snippet?}]}，字段名兼容 href/description。 */
function readSearchHits(payload: unknown): SearchHit[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === "object" && Array.isArray((payload as { results?: unknown }).results)
      ? (payload as { results: unknown[] }).results
      : [];
  return rows
    .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
    .map((row) => ({
      title: String(row.title ?? "(无标题)"),
      url: String(row.url ?? row.href ?? ""),
      snippet: String(row.snippet ?? row.description ?? row.summary ?? ""),
      publishedAt: String(row.date ?? row.publishedAt ?? ""),
    }))
    .filter((hit) => hit.url !== "");
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: timer.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Web 工具执行器：供 createLoopExecutor 的 extras 注入，返回 {ok, summary}。 */
export function createWebExtras(cfg: RuntimeConfig): Record<string, (args: Record<string, unknown>) => Promise<{ ok: boolean; summary: string }>> {
  return {
    [WEB_SEARCH_TOOL]: async (args) => {
      const query = String(args.query ?? "").trim();
      if (query === "") return { ok: false, summary: "query 不能为空" };
      const custom = cfg.webSearchUrl !== "";
      if (!custom && !deepseekSearchAvailable(cfg)) {
        return { ok: false, summary: "搜索不可用：未配置 CORDIBANK_WEB_SEARCH_URL 且无 DeepSeek API key" };
      }
      const endpoint = custom ? cfg.webSearchUrl : deepseekToolsBase() + "/search";
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (custom) {
        if (cfg.webSearchKey !== "") headers.authorization = "Bearer " + cfg.webSearchKey;
      } else {
        headers.authorization = "Bearer " + cfg.llm.apiKey;
      }
      const body: Record<string, unknown> = custom ? { query, count: SEARCH_RESULT_COUNT } : { query, count: SEARCH_RESULT_COUNT, need_content: false };
      try {
        const response = await fetchWithTimeout(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        if (!response.ok) return { ok: false, summary: "搜索端点返回 HTTP " + response.status };
        const hits = readSearchHits(await response.json());
        if (hits.length === 0) return { ok: true, summary: "搜索无结果：" + query };
        const lines = hits.map((hit, index) =>
          (index + 1) + ". " + hit.title + " — " + hit.url
          + (hit.publishedAt === "" ? "" : "（" + hit.publishedAt + "）")
          + (hit.snippet === "" ? "" : "\n   " + hit.snippet),
        );
        return { ok: true, summary: lines.join("\n") };
      } catch (error) {
        return { ok: false, summary: "搜索调用失败：" + String(error instanceof Error ? error.message : error) };
      }
    },
    [WEB_FETCH_TOOL]: async (args) => {
      const raw = String(args.url ?? "").trim();
      let target: URL;
      try {
        target = new URL(raw);
      } catch {
        return { ok: false, summary: "URL 无法解析：" + raw };
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return { ok: false, summary: "仅支持 http(s) 地址：" + target.protocol };
      }
      if (isBlockedHost(target.hostname)) return { ok: false, summary: "拒绝抓取内网或环回地址：" + target.hostname };
      const directFail = async (summary: string): Promise<{ ok: boolean; summary: string }> => {
        if (!deepseekSearchAvailable(cfg)) return { ok: false, summary };
        try {
          const response = await fetchWithTimeout(deepseekToolsBase() + "/fetch", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer " + cfg.llm.apiKey },
            body: JSON.stringify({ url: target.href }),
          });
          if (!response.ok) return { ok: false, summary: summary + "；DeepSeek Fetch 回退也返回 HTTP " + response.status };
          const payload = (await response.json()) as { content?: unknown };
          if (typeof payload.content !== "string" || payload.content.trim() === "") {
            return { ok: false, summary: summary + "；DeepSeek Fetch 回退无正文" };
          }
          const text = payload.content.trim();
          return { ok: true, summary: text.length > FETCH_SUMMARY_LIMIT ? text.slice(0, FETCH_SUMMARY_LIMIT) + "…（已截断）" : text };
        } catch (error) {
          return { ok: false, summary: summary + "；DeepSeek Fetch 回退失败：" + String(error instanceof Error ? error.message : error) };
        }
      };
      try {
        const response = await fetchWithTimeout(target.href, { method: "GET", redirect: "follow" });
        if (!response.ok) return await directFail("抓取返回 HTTP " + response.status);
        const declared = Number(response.headers.get("content-length") ?? "0");
        if (declared > FETCH_BODY_LIMIT) return { ok: false, summary: "页面过大（" + declared + " 字节），超过抓取上限" };
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > FETCH_BODY_LIMIT) return { ok: false, summary: "页面过大（" + buffer.byteLength + " 字节），超过抓取上限" };
        const summary = extractText(new TextDecoder().decode(buffer));
        if (summary === "") return { ok: true, summary: "页面无可见正文：" + target.href };
        return { ok: true, summary };
      } catch (error) {
        return await directFail("抓取失败：" + String(error instanceof Error ? error.message : error));
      }
    },
  };
}
