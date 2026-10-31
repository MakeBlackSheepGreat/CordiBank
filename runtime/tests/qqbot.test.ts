/**
 * QQ 官方机器人客户端：按官方协议校验取凭证、鉴权头、网关握手与发消息字段。
 * 这里不打真实网络，用假 fetch 与假 WebSocket 校验帧结构。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_QQBOT_API_BASE,
  QQ_INTENTS_GROUP_AND_C2C,
  QqBotSession,
  fetchAccessToken,
  fetchGatewayUrl,
  sendC2CText,
  sendGroupText,
  type QqBotMessage,
} from "../src/channels/qqbot.ts";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/** 假 fetch：按 URL 命中预设回包并记录请求。 */
function stubFetch(responder: (url: string) => unknown): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>),
    });
    return new Response(JSON.stringify(responder(url)), { status: 200 });
  }) as unknown as typeof fetch);
  return calls;
}

type Listener = (event: { data?: unknown }) => void;

/** 假 WebSocket：记录发出的帧，并允许测试主动推事件。 */
class FakeSocket {
  static last: FakeSocket | undefined;
  readonly url: string;
  readonly sent: string[] = [];
  readyState = 1;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close", {});
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** 推一帧网关消息。 */
  push(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

async function waitForSocket(): Promise<FakeSocket> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (FakeSocket.last !== undefined) return FakeSocket.last;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("连接未建立");
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeSocket.last = undefined;
});

describe("QQ 官方机器人：取凭证与网关", () => {
  it("按官方路径换 access_token，缺字段直接拒绝", async () => {
    const calls = stubFetch(() => ({ access_token: "tok-1", expires_in: 7200 }));
    const credential = await fetchAccessToken(DEFAULT_QQBOT_API_BASE, "102000001", "secret-x");
    expect(credential).toEqual({ accessToken: "tok-1", expiresIn: 7200 });
    expect(calls[0].url).toBe("https://api.bot.qq.com/app/getAppAccessToken");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ appId: "102000001", clientSecret: "secret-x" });
    await expect(fetchAccessToken(DEFAULT_QQBOT_API_BASE, "", "secret-x")).rejects.toThrow(/AppID/);
  });

  it("HTTP 200 但 code 非零按失败处理，带出官方 message", async () => {
    stubFetch(() => ({ code: 10004, message: "机器人不存在" }));
    await expect(fetchAccessToken(DEFAULT_QQBOT_API_BASE, "102000000", "bad")).rejects.toThrow(/机器人不存在.*10004/);
  });

  it("网关请求带 QQBot 鉴权头，缺 url 报可读错误", async () => {
    const calls = stubFetch(() => ({ url: "wss://api.sgroup.qq.com/websocket" }));
    await expect(fetchGatewayUrl(DEFAULT_QQBOT_API_BASE, "tok-1")).resolves.toBe("wss://api.sgroup.qq.com/websocket");
    expect(calls[0].headers.authorization).toBe("QQBot tok-1");
    stubFetch(() => ({ code: 11244 }));
    await expect(fetchGatewayUrl(DEFAULT_QQBOT_API_BASE, "tok-1")).rejects.toThrow(/网关地址获取失败/);
  });
});

describe("QQ 官方机器人：发消息", () => {
  it("群聊被动回复带 msg_id 与 msg_seq，鉴权头为 QQBot", async () => {
    const calls = stubFetch(() => ({ id: "m-2", timestamp: 1 }));
    await sendGroupText(DEFAULT_QQBOT_API_BASE, "tok-1", "group-openid-1", "查余额", "m-1", 2);
    expect(calls[0].url).toBe("https://api.bot.qq.com/v2/groups/group-openid-1/messages");
    expect(calls[0].headers.authorization).toBe("QQBot tok-1");
    expect(calls[0].body).toEqual({ content: "查余额", msg_type: 0, msg_id: "m-1", msg_seq: 2 });
  });

  it("单聊走 /v2/users 路径；官方返回非零 code 时抛错", async () => {
    const calls = stubFetch(() => ({ id: "m-2" }));
    await sendC2CText(DEFAULT_QQBOT_API_BASE, "tok-2", "user-openid-1", "转账", "", 1);
    expect(calls[0].url).toBe("https://api.bot.qq.com/v2/users/user-openid-1/messages");
    // 主动消息不带 msg_id
    expect(calls[0].body).toEqual({ content: "转账", msg_type: 0 });
    stubFetch(() => ({ code: 40034, message: "消息发送失败" }));
    await expect(sendC2CText(DEFAULT_QQBOT_API_BASE, "tok-2", "u-1", "hi", "m-1", 1)).rejects.toThrow(/消息发送失败/);
  });
});

describe("QQ 官方机器人：长连接会话", () => {
  it("HELLO 后发 IDENTIFY，READY 后置为已连接并分发消息", async () => {
    stubFetch((url) => {
      if (url.includes("getAppAccessToken")) return { access_token: "tok-9", expires_in: 7200 };
      return { url: "wss://gateway.example/ws" };
    });
    vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof globalThis.WebSocket);
    const received: QqBotMessage[] = [];
    const states: string[] = [];
    const session = new QqBotSession({
      apiBase: DEFAULT_QQBOT_API_BASE,
      appId: "102000001",
      clientSecret: "secret-x",
      onMessage: (message) => {
        received.push(message);
      },
      onState: (state) => {
        states.push(state);
      },
    });

    const connecting = session.connect();
    const socket = await waitForSocket();
    expect(socket.url).toBe("wss://gateway.example/ws");
    socket.push({ op: 10, d: { heartbeat_interval: 45000 } });
    socket.push({ op: 0, t: "READY", s: 1, d: {} });
    await connecting;

    expect(session.connected).toBe(true);
    expect(states).toEqual(["connecting", "open"]);
    const identify = JSON.parse(socket.sent[0]) as { op: number; d: { token: string; intents: number; shard: number[] } };
    expect(identify.op).toBe(2);
    expect(identify.d.token).toBe("QQBot tok-9");
    expect(identify.d.intents).toBe(QQ_INTENTS_GROUP_AND_C2C);
    expect(identify.d.shard).toEqual([0, 1]);

    socket.push({
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      s: 2,
      d: { id: "msg-1", content: "<@!1234> 查一下余额", group_openid: "g-1", author: { member_openid: "u-1" }, timestamp: 1730000000000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ eventType: "GROUP_AT_MESSAGE_CREATE", content: "查一下余额", groupOpenid: "g-1", userOpenid: "u-1", messageId: "msg-1" });
    expect(received[0].timestamp).toBe(new Date(1730000000000).toISOString());

    session.disconnect();
    expect(session.connected).toBe(false);
  });

  it("未配置凭证时连接直接报可读错误", async () => {
    const session = new QqBotSession({
      apiBase: DEFAULT_QQBOT_API_BASE,
      appId: "",
      clientSecret: "",
      onMessage: () => undefined,
      onState: () => undefined,
    });
    await expect(session.connect()).rejects.toThrow(/AppID 与 AppSecret/);
  });
});
