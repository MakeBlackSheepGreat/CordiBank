import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { createChannelsPlugin } from "../src/plugins/channels.ts";
import { loadConfig, type RuntimeConfig } from "../src/config.ts";
import type { CapabilityPlugin } from "../src/capabilities/types.ts";

const base = path.join(process.cwd(), ".test-tmp");

interface Captured {
  path: string;
  authorization: string;
  body: Record<string, unknown>;
}

/** QQ OneBot HTTP API 的替身：捕获发消息请求。 */
function startQqStub(): Promise<{ server: Server; url: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      captured.push({
        path: req.url ?? "",
        authorization: String(req.headers.authorization ?? ""),
        body: JSON.parse(raw === "" ? "{}" : raw) as Record<string, unknown>,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "async", retcode: 0 }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ server, url: "http://127.0.0.1:" + port, captured });
    });
  });
}

function fakeBank(): CapabilityPlugin {
  return {
    name: "bank-agent",
    def: { service: "bank.agent", methods: ["chat"] },
    provider: {
      chat: async (sessionId: unknown, text: unknown) => ({ sessionId, reply: "伪回复：" + String(text) }),
    },
  } as unknown as CapabilityPlugin;
}

const fakeDeps = () => ({ get: (id: string) => (id === "bank-agent" ? fakeBank() : undefined) });

function makeCfg(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  mkdirSync(base, { recursive: true });
  return loadConfig({ storeDir: mkdtempSync(path.join(base, "channels-")), ...overrides });
}

let stub: { server: Server; url: string; captured: Captured[] } | undefined;
let lastCfg: RuntimeConfig | undefined;

afterEach(() => {
  stub?.server.close();
  stub = undefined;
  if (lastCfg !== undefined) rmSync(lastCfg.storeDir, { recursive: true, force: true });
  lastCfg = undefined;
});

describe("渠道接入中心", () => {
  it("默认状态：web/desktop 激活，qq 未配置，webhook 待桥接", () => {
    const plugin = createChannelsPlugin(makeCfg(), fakeDeps());
    const status = plugin.provider.status() as { channels: Array<{ id: string; state: string; messageCount: number }> };
    const byId = new Map(status.channels.map((c) => [c.id, c]));
    expect(byId.get("web")?.state).toBe("active");
    expect(byId.get("desktop")?.state).toBe("active");
    expect(byId.get("qq")?.state).toBe("unconfigured");
    expect(byId.get("webhook")?.state).toBe("ready");
    expect(byId.get("qq")?.messageCount).toBe(0);
  });

  it("QQ 私聊：上报进会话，回复经 send_private_msg 送回", async () => {
    stub = await startQqStub();
    lastCfg = makeCfg({ channelQqApiUrl: stub.url });
    const plugin = createChannelsPlugin(lastCfg, fakeDeps());
    const result = (await plugin.provider.incoming("onebot", {
      post_type: "message",
      message_type: "private",
      user_id: 10001,
      raw_message: "查一下余额",
    })) as { ok: boolean; channel: string; reply: string; delivered: boolean };
    expect(result.ok).toBe(true);
    expect(result.channel).toBe("qq");
    expect(result.reply).toBe("伪回复：查一下余额");
    expect(result.delivered).toBe(true);
    expect(stub.captured).toHaveLength(1);
    expect(stub.captured[0].path).toBe("/send_private_msg");
    expect(stub.captured[0].body.user_id).toBe(10001);
    expect(String(stub.captured[0].body.message)).toContain("伪回复：查一下余额");
  });

  it("QQ 群聊：回复经 send_group_msg 送回且带 group_id", async () => {
    stub = await startQqStub();
    lastCfg = makeCfg({ channelQqApiUrl: stub.url });
    const plugin = createChannelsPlugin(lastCfg, fakeDeps());
    await plugin.provider.incoming("onebot", {
      post_type: "message",
      message_type: "group",
      user_id: 20002,
      group_id: 555,
      raw_message: [{ type: "text", data: { text: "群内查账单" } }],
    });
    expect(stub.captured[0].path).toBe("/send_group_msg");
    expect(stub.captured[0].body.group_id).toBe(555);
    expect(String(stub.captured[0].body.message)).toContain("伪回复：群内查账单");
  });

  it("令牌校验：不匹配拒绝，匹配放行并带 Bearer 头", async () => {
    stub = await startQqStub();
    lastCfg = makeCfg({ channelQqApiUrl: stub.url, channelQqToken: "tok-123" });
    const plugin = createChannelsPlugin(lastCfg, fakeDeps());
    const report = { post_type: "message", message_type: "private", user_id: 1, raw_message: "hi" };
    await expect(plugin.provider.incoming("onebot", { ...report, token: "bad" })).rejects.toThrow(/令牌不匹配/);
    expect(stub.captured).toHaveLength(0);
    const result = (await plugin.provider.incoming("onebot", { ...report, token: "tok-123" })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(stub.captured[0].authorization).toBe("Bearer tok-123");
  });

  it("非消息事件与空文本直接忽略，不进会话", async () => {
    stub = await startQqStub();
    lastCfg = makeCfg({ channelQqApiUrl: stub.url });
    const plugin = createChannelsPlugin(lastCfg, fakeDeps());
    const heartbeat = (await plugin.provider.incoming("onebot", { post_type: "meta_event", meta_event_type: "heartbeat" })) as { ignored: boolean };
    expect(heartbeat.ignored).toBe(true);
    const empty = (await plugin.provider.incoming("onebot", { post_type: "message", message_type: "private", user_id: 1, raw_message: "   " })) as { ignored: boolean };
    expect(empty.ignored).toBe(true);
    expect(stub.captured).toHaveLength(0);
  });

  it("webhook 桥：进文本出回复，状态里消息计数与事件序正确", async () => {
    lastCfg = makeCfg();
    const plugin = createChannelsPlugin(lastCfg, fakeDeps());
    const result = (await plugin.provider.incoming("webhook", { channel: "wechat", from: "wx-张三", text: "查账单" })) as { ok: boolean; channel: string; reply: string };
    expect(result.ok).toBe(true);
    expect(result.channel).toBe("wechat");
    expect(result.reply).toBe("伪回复：查账单");
    const status = plugin.provider.status() as {
      channels: Array<{ id: string; state: string; messageCount: number; lastMessageAt?: string }>;
      events: Array<{ channel: string; direction: string; text: string }>;
    };
    const wechat = status.channels.find((c) => c.id === "webhook");
    expect(wechat?.state).toBe("active");
    expect(wechat?.messageCount).toBe(1);
    expect(wechat?.lastMessageAt).toBeTruthy();
    expect(status.events.map((e) => e.direction)).toEqual(["out", "in"]);
    expect(status.events[0].text).toBe("伪回复：查账单");
  });

  it("未知渠道与非法负载拒绝", async () => {
    lastCfg = makeCfg();
    const plugin = createChannelsPlugin(lastCfg, fakeDeps());
    await expect(plugin.provider.incoming("telegram", {})).rejects.toThrow(/未知渠道/);
    await expect(plugin.provider.incoming("webhook", null)).rejects.toThrow(/JSON 对象/);
    await expect(plugin.provider.incoming("webhook", { text: "" })).rejects.toThrow(/非空 text/);
  });

  it("QQ API 未配置时上报报可读错误", async () => {
    lastCfg = makeCfg();
    const plugin = createChannelsPlugin(lastCfg, fakeDeps());
    await expect(
      plugin.provider.incoming("onebot", { post_type: "message", message_type: "private", user_id: 1, raw_message: "hi" }),
    ).rejects.toThrow(/QQ API 未配置/);
  });

  it("默认状态：七个渠道全部在列，openclaw/钉钉/飞书按配置待配置", () => {
    const plugin = createChannelsPlugin(makeCfg(), fakeDeps());
    const status = plugin.provider.status() as { channels: Array<{ id: string; name: string }> };
    expect(status.channels.map((c) => c.id)).toEqual(["web", "desktop", "openclaw", "qq", "dingtalk", "feishu", "webhook"]);
  });

  it("钉钉：sign 校验通过同步回包，签名错误拒绝", async () => {
    const { createHmac } = await import("node:crypto");
    lastCfg = makeCfg({ channelDingtalkSecret: "secret-abc" });
    const plugin = createChannelsPlugin(lastCfg, fakeDeps());
    const ts = String(Date.now());
    const sign = createHmac("sha256", "secret-abc").update(ts + "\n" + "secret-abc").digest("base64");
    const result = (await plugin.provider.incoming("dingtalk", { senderStaffId: "staff-1", text: { content: "查余额" } }, { timestamp: ts, sign })) as { ok: boolean; rawBody?: { msgtype: string; text: { content: string } } };
    expect(result.ok).toBe(true);
    expect(result.rawBody?.msgtype).toBe("text");
    expect(result.rawBody?.text.content).toBe("伪回复：查余额");
    await expect(
      plugin.provider.incoming("dingtalk", { senderStaffId: "staff-1", text: { content: "查余额" } }, { timestamp: ts, sign: "wrong" }),
    ).rejects.toThrow(/钉钉签名校验失败/);
    await expect(
      plugin.provider.incoming("dingtalk", { senderStaffId: "staff-1", text: { content: "查余额" } }, { timestamp: "1", sign }),
    ).rejects.toThrow(/时间戳/);
  });

  it("飞书：challenge 原样直返，事件进会话并经 tenant_access_token 送回", async () => {
    const posted: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      posted.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
      if (String(url).includes("/tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tnt-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }) as unknown as typeof fetch);
    try {
      lastCfg = makeCfg({ channelFeishuAppId: "app-1", channelFeishuAppSecret: "s1", channelFeishuToken: "vt-1" });
      const plugin = createChannelsPlugin(lastCfg, fakeDeps());
      const challenge = (await plugin.provider.incoming("feishu", { type: "url_verification", token: "vt-1", challenge: "ch-xyz" })) as { rawBody?: { challenge: string } };
      expect(challenge.rawBody?.challenge).toBe("ch-xyz");
      const content = JSON.stringify({ text: "@_user_1 转账给王晓明" });
      const result = (await plugin.provider.incoming("feishu", {
        header: { event_type: "im.message.receive_v1", token: "vt-1" },
        event: { sender: { sender_id: { open_id: "ou-9" } }, message: { chat_id: "oc-1", message_type: "text", content } },
      })) as { ok: boolean; reply: string };
      expect(result.ok).toBe(true);
      expect(result.reply).toBe("伪回复：转账给王晓明");
      expect(posted.some((r) => r.url.includes("/im/v1/messages") && r.body.receive_id === "oc-1")).toBe(true);
      expect(posted.some((r) => r.url.includes("/im/v1/messages") && String(r.body.content).includes("@_user_"))).toBe(false);
      const badToken = (await plugin.provider.incoming("feishu", { type: "url_verification", token: "bad", challenge: "c" }).then(() => "ok", (e: unknown) => String(e))) as string;
      expect(badToken).toContain("令牌不匹配");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it("OpenClaw：令牌匹配进会话，未配置/不匹配拒绝", async () => {
    lastCfg = makeCfg({ channelOpenclawToken: "hook-1" });
    const plugin = createChannelsPlugin(lastCfg, fakeDeps());
    const result = (await plugin.provider.incoming("openclaw", { message: "查账单", name: "wx-alice" }, { authorization: "Bearer hook-1" })) as { ok: boolean; reply: string; from: string };
    expect(result.ok).toBe(true);
    expect(result.reply).toBe("伪回复：查账单");
    expect(result.from).toBe("wx-alice");
    const unconfigured = makeCfg();
    const bare = createChannelsPlugin(unconfigured, fakeDeps());
    await expect(bare.provider.incoming("openclaw", { message: "hi" }, {})).rejects.toThrow(/OpenClaw hook 令牌未配置/);
    await expect(plugin.provider.incoming("openclaw", { message: "hi" }, { authorization: "Bearer wrong" })).rejects.toThrow(/令牌不匹配/);
  });
});
