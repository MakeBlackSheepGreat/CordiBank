import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL, createWebExtras, webToolDescriptors } from "../src/bank/web-tools.ts";

const ENV_KEYS = [
  "CORDIBANK_WEB_SEARCH",
  "CORDIBANK_WEB_SEARCH_URL",
  "CORDIBANK_WEB_SEARCH_KEY",
  "LLM_API_KEY",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_SEARCH_BASE_URL",
];

function withEnv(mutate: () => void): void {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    mutate();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** SSE 无关：这里用 Response 构造一个最小 fetch stub。 */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) =>
    await handler(String(url), init)) as unknown as typeof fetch);
}

const cfg = (over: Partial<Parameters<typeof webToolDescriptors>[0]> = {}) =>
  loadConfig({ storeDir: "cordibank-test-tmp/store", skillsDir: "cordibank-test-tmp/skills", ...over });

const htmlResponse = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } });

describe("web 工具描述符", () => {
  it("未配置搜索端点时只注册 web_fetch", () => {
    const descriptors = webToolDescriptors(cfg());
    expect(descriptors.map((item) => item.name)).toEqual([WEB_FETCH_TOOL]);
  });

  it("配置端点后注册 web_search 与 web_fetch，均为绿色只读", () => {
    const descriptors = webToolDescriptors(cfg({ webSearchUrl: "https://search.example.com/api" }));
    expect(descriptors.map((item) => item.name)).toEqual([WEB_SEARCH_TOOL, WEB_FETCH_TOOL]);
    for (const item of descriptors) {
      expect(item.risk).toEqual({ level: "green", reversible: true, write: false });
      expect(item.scene).toBe("cross");
    }
  });

  it("无自定义端点但有 DeepSeek key 时也注册 web_search", () => {
    withEnv(() => {
      process.env.LLM_API_KEY = "sk-test";
      const descriptors = webToolDescriptors(cfg());
      expect(descriptors.map((item) => item.name)).toEqual([WEB_SEARCH_TOOL, WEB_FETCH_TOOL]);
    });
  });

  it("CORDIBANK_WEB_SEARCH=off 时关闭全部 web 工具", () => {
    withEnv(() => {
      process.env.CORDIBANK_WEB_SEARCH = "off";
      process.env.CORDIBANK_WEB_SEARCH_URL = "https://search.example.com/api";
      const descriptors = webToolDescriptors(cfg());
      expect(descriptors).toEqual([]);
    });
  });
});

describe("web 工具执行器", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("搜索端点未配置时返回明确错误", async () => {
    const extras = createWebExtras(cfg());
    const result = await extras[WEB_SEARCH_TOOL]!({ query: "汇率" });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("搜索不可用");
  });

  it("搜索走配置端点并兼容 href/description 字段", async () => {
    let capturedBody = "";
    let capturedAuth = "";
    stubFetch(async (url, init) => {
      expect(url).toBe("https://search.example.com/api");
      capturedBody = String(init?.body ?? "");
      capturedAuth = String(new Headers(init?.headers).get("authorization") ?? "");
      return htmlResponse(JSON.stringify({ results: [
        { title: "牌价", href: "https://fx.example.com", description: "今日美元牌价" },
        { title: "无链接条目" },
      ] }), { "content-type": "application/json" });
    });
    const extras = createWebExtras(cfg({ webSearchUrl: "https://search.example.com/api", webSearchKey: "k-123" }));
    const result = await extras[WEB_SEARCH_TOOL]!({ query: "美元 汇率" });
    expect(result.ok).toBe(true);
    expect(capturedBody).toContain("美元 汇率");
    expect(capturedAuth).toBe("Bearer k-123");
    expect(result.summary).toContain("1. 牌价 — https://fx.example.com");
    expect(result.summary).toContain("今日美元牌价");
    expect(result.summary).not.toContain("无链接条目");
  });

  it("免费搜索：无自定义端点时走 DeepSeek Search API", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    let capturedBody = "";
    stubFetch(async (url, init) => {
      capturedUrl = url;
      capturedAuth = String(new Headers(init?.headers).get("authorization") ?? "");
      capturedBody = String(init?.body ?? "");
      return htmlResponse(JSON.stringify({ results: [
        { url: "https://fx.example.com/usd", title: "美元牌价", summary: "中间价 7.1", date: "2026-10-31" },
      ] }), { "content-type": "application/json" });
    });
    const extras = createWebExtras(cfg({ llm: { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-live", model: "deepseek-chat", timeoutMs: 30000, temperature: 0.3, maxTokens: 2048, effort: "low" } }));
    const result = await extras[WEB_SEARCH_TOOL]!({ query: "美元 汇率" });
    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe("https://api.deepseek.com/v1/tools/search");
    expect(capturedAuth).toBe("Bearer sk-live");
    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(body.query).toBe("美元 汇率");
    expect(body.count).toBe(5);
    expect(body.need_content).toBe(false);
    expect(result.summary).toContain("美元牌价 — https://fx.example.com/usd（2026-10-31）");
    expect(result.summary).toContain("中间价 7.1");
  });

  it("直连抓取失败时回退 DeepSeek Fetch API（markdown）", async () => {
    const calls: Array<{ url: string; body: string; auth: string }> = [];
    stubFetch(async (url, init) => {
      calls.push({ url, body: String(init?.body ?? ""), auth: String(new Headers(init?.headers).get("authorization") ?? "") });
      if (url.includes("/fetch")) {
        return htmlResponse(JSON.stringify({ content: "# 页面正文\n\n关键数据 7.1" }), { "content-type": "application/json" });
      }
      return new Response("nope", { status: 404 });
    });
    const extras = createWebExtras(cfg({ llm: { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-live", model: "deepseek-chat", timeoutMs: 30000, temperature: 0.3, maxTokens: 2048, effort: "low" } }));
    const result = await extras[WEB_FETCH_TOOL]!({ url: "https://www.example.com/js-heavy" });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("关键数据 7.1");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(JSON.parse(calls[1]!.body)).toEqual({ url: "https://www.example.com/js-heavy" });
    expect(calls[1]!.auth).toBe("Bearer sk-live");
  });

  it("DEEPSEEK_SEARCH_BASE_URL 覆盖默认基址", async () => {
    vi.stubEnv("LLM_API_KEY", "sk-test");
    vi.stubEnv("DEEPSEEK_SEARCH_BASE_URL", "https://gw.internal/api/v1/tools");
    let capturedUrl = "";
    stubFetch(async (url) => {
      capturedUrl = url;
      return htmlResponse(JSON.stringify({ results: [] }), { "content-type": "application/json" });
    });
    const extras = createWebExtras(cfg());
    const result = await extras[WEB_SEARCH_TOOL]!({ query: "x" });
    expect(capturedUrl).toBe("https://gw.internal/api/v1/tools/search");
    expect(result.summary).toContain("搜索无结果");
    vi.unstubAllEnvs();
  });

  it("抓取网页并抽取纯文本", async () => {
    stubFetch(async () => htmlResponse("<html><head><style>.x{}</style></head><body><h1>汇率公告</h1><p>美元&nbsp;7.1&amp;上涨</p><script>evil()</script></body></html>"));
    const extras = createWebExtras(cfg());
    const result = await extras[WEB_FETCH_TOOL]!({ url: "https://www.example.com/rate" });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("汇率公告");
    expect(result.summary).toContain("美元 7.1&上涨");
    expect(result.summary).not.toContain("evil");
    expect(result.summary).not.toContain(".x{}");
  });

  it("拒绝内网与非 http(s) 地址，防 SSRF", async () => {
    const extras = createWebExtras(cfg());
    const intranet = await extras[WEB_FETCH_TOOL]!({ url: "http://192.168.1.10/admin" });
    expect(intranet.ok).toBe(false);
    expect(intranet.summary).toContain("拒绝抓取内网");
    const loopback = await extras[WEB_FETCH_TOOL]!({ url: "http://localhost:8123/rpc" });
    expect(loopback.summary).toContain("拒绝抓取内网");
    const fileUrl = await extras[WEB_FETCH_TOOL]!({ url: "file:///C:/Windows/win.ini" });
    expect(fileUrl.summary).toContain("仅支持 http(s)");
  });

  it("HTTP 错误与超限页面返回失败摘要", async () => {
    stubFetch(async (url) =>
      url.includes("big")
        ? htmlResponse("x", { "content-length": String(600 * 1024) })
        : new Response("nope", { status: 404 }));
    const extras = createWebExtras(cfg());
    const big = await extras[WEB_FETCH_TOOL]!({ url: "https://www.example.com/big" });
    expect(big.ok).toBe(false);
    expect(big.summary).toContain("页面过大");
    const missing = await extras[WEB_FETCH_TOOL]!({ url: "https://www.example.com/missing" });
    expect(missing.summary).toContain("HTTP 404");
  });
});
