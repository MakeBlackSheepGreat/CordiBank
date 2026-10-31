import { createHmac } from "node:crypto";
import type { CapabilityPlugin } from "../capabilities/types.ts";
import type { RuntimeConfig } from "../config.ts";
import { RuntimeError } from "../core/errors.ts";

/**
 * 渠道接入中心：把 IM 渠道接进银行 Agent 会话。
 * - 微信：OpenClaw 网关 hooks 兼容入口（Bearer 令牌），由 OpenClaw 负责微信侧收发；
 * - QQ：OneBot v11 HTTP 上报（NapCat/Lagrange 兼容），回复经 HTTP API 送回；
 * - 钉钉：企业内部机器人官方 HTTP 回调（sign 加签验签），同步原样回包；
 * - 飞书：事件订阅官方回调（url_verification challenge 握手），经 tenant_access_token 送回；
 * - webhook：通用 HTTP 桥（任何能 POST 的桥接程序都可用），POST 进来即回 JSON；
 * - web/desktop：内置渠道，前端控制台与桌面壳直连 RPC，不走此适配层。
 */

export type ChannelState = "active" | "ready" | "unconfigured";

export interface ChannelView {
  id: string;
  name: string;
  description: string;
  state: ChannelState;
  messageCount: number;
  lastMessageAt?: string;
}

export interface ChannelEvent {
  ts: string;
  channel: string;
  from: string;
  direction: "in" | "out";
  text: string;
}

export interface ChannelsStatus {
  channels: ChannelView[];
  events: ChannelEvent[];
}

const MAX_EVENTS = 50;
const MAX_TEXT_CHARS = 2000;
const CHANNEL_IDS = new Set(["onebot", "webhook", "dingtalk", "feishu", "openclaw"]);
/** 钉钉官方验签允许的时间偏差（文档口径 ±1 小时）。 */
const DINGTALK_SIGN_TOLERANCE_MS = 3600_000;

function clipText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + "…（已截断）" : text;
}

/** OneBot v11 的消息字段可能是纯文本，也可能是消息段数组，统一抽出正文。 */
function onebotText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((seg) => {
        if (seg !== null && typeof seg === "object") {
          const rec = seg as Record<string, unknown>;
          const data = rec.data as Record<string, unknown> | undefined;
          if (rec.type === "text" && typeof data?.text === "string") return data.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

type PluginDeps = { get(id: string): CapabilityPlugin | undefined };
/** 渠道验签用请求头快照（server.ts 只透传少数白名单头，键已小写）。 */
type ChannelMeta = Record<string, string>;

export function createChannelsPlugin(cfg: RuntimeConfig, deps: PluginDeps): CapabilityPlugin {
  const counters = new Map<string, { count: number; lastAt?: string }>();
  const events: ChannelEvent[] = [];

  const touch = (id: string) => {
    const entry = counters.get(id) ?? { count: 0 };
    entry.count += 1;
    entry.lastAt = new Date().toISOString();
    counters.set(id, entry);
  };

  const logEvent = (channel: string, from: string, direction: "in" | "out", text: string) => {
    events.push({ ts: new Date().toISOString(), channel, from, direction, text: clipText(text) });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  };

  const bankProvider = () => {
    const bank = deps.get("bank-agent");
    if (bank === undefined) throw new RuntimeError("RESOURCE_UNAVAILABLE", "渠道接入依赖的 bank-agent 插件未装载");
    return bank.provider;
  };

  /** 从 bank.agent.chat 回包抽正文：reply / chat.reply / loop.text。 */
  const extractReply = (result: unknown): string => {
    if (result !== null && typeof result === "object") {
      const rec = result as Record<string, unknown>;
      if (typeof rec.reply === "string") return rec.reply;
      if (rec.chat !== null && typeof rec.chat === "object") {
        const chat = rec.chat as Record<string, unknown>;
        if (typeof chat.reply === "string") return chat.reply;
      }
      if (rec.loop !== null && typeof rec.loop === "object") {
        const loop = rec.loop as Record<string, unknown>;
        if (typeof loop.text === "string") return loop.text;
      }
    }
    return "";
  };

  const callAgent = async (sessionId: string, text: string): Promise<string> => {
    const result = await bankProvider().chat(sessionId, text);
    return extractReply(result);
  };

  const postJson = async (url: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<Record<string, unknown>> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new RuntimeError("RESOURCE_UNAVAILABLE", "渠道送回接口回包异常：" + String(res.status));
    return (await res.json()) as Record<string, unknown>;
  };

  const postToOnebot = async (path: string, body: Record<string, unknown>): Promise<void> => {
    if (cfg.channelQqApiUrl === "") {
      throw new RuntimeError("RESOURCE_UNAVAILABLE", "QQ API 未配置（CORDIBANK_CHANNEL_QQ_API），无法送回回复");
    }
    const base = cfg.channelQqApiUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = {};
    if (cfg.channelQqToken !== "") headers.authorization = "Bearer " + cfg.channelQqToken;
    await postJson(base + path, body, headers);
  };

  const handleOnebot = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (cfg.channelQqToken !== "" && payload.token !== cfg.channelQqToken) {
      throw new RuntimeError("ACCESS_DENIED", "上报令牌不匹配");
    }
    const postType = str(payload, "post_type");
    if (postType !== "message") return { ok: true, ignored: true };
    const message = onebotText(payload.raw_message ?? payload.message).trim();
    if (message === "") return { ok: true, ignored: true };
    const isPrivate = payload.message_type === "private";
    const userId = String(payload.user_id ?? "");
    const groupId = String(payload.group_id ?? "");
    if (userId === "") throw new RuntimeError("INVALID_INPUT", "OneBot 上报缺少 user_id");
    const from = isPrivate ? "QQ:" + userId : "群" + groupId + ":" + userId;
    logEvent("qq", from, "in", message);
    touch("qq");
    const reply = await callAgent("qq-" + userId, message);
    logEvent("qq", from, "out", reply);
    if (isPrivate) {
      await postToOnebot("/send_private_msg", { user_id: payload.user_id, message: reply });
    } else {
      if (groupId === "") throw new RuntimeError("INVALID_INPUT", "群消息上报缺少 group_id");
      await postToOnebot("/send_group_msg", { group_id: payload.group_id, message: reply });
    }
    return { ok: true, channel: "qq", from, reply, delivered: true };
  };

  const handleWebhook = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const from = str(payload, "from").trim() !== "" ? str(payload, "from").trim() : "anonymous";
    const text = str(payload, "text");
    if (text.trim() === "") throw new RuntimeError("INVALID_INPUT", "webhook 上报需要非空 text 字段");
    const source = str(payload, "channel").trim() !== "" ? str(payload, "channel").trim() : "wechat";
    // from 只用于会话键：限定字符集，防会话键注入。
    const safeFrom = from.replace(/[^A-Za-z0-9_.:-]/g, "_");
    logEvent(source, from, "in", text);
    // 渠道总计数按 webhook，事件明细保留子渠道（wechat 等）来源标签。
    touch(source);
    touch("webhook");
    const reply = await callAgent("webhook-" + source + "-" + safeFrom, text);
    logEvent(source, from, "out", reply);
    return { ok: true, channel: source, from, reply };
  };

  /** 钉钉官方加签：sign = base64(HMAC-SHA256(appSecret, timestamp + "\n" + appSecret))。 */
  const verifyDingtalkSign = (meta: ChannelMeta): void => {
    if (cfg.channelDingtalkSecret === "") return;
    const ts = Number(meta.timestamp ?? "");
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > DINGTALK_SIGN_TOLERANCE_MS) {
      throw new RuntimeError("ACCESS_DENIED", "钉钉签名时间戳缺失或超出允许偏差");
    }
    const expected = createHmac("sha256", cfg.channelDingtalkSecret)
      .update(String(ts) + "\n" + cfg.channelDingtalkSecret)
      .digest("base64");
    if (expected !== (meta.sign ?? "")) {
      throw new RuntimeError("ACCESS_DENIED", "钉钉签名校验失败");
    }
  };

  const handleDingtalk = async (payload: Record<string, unknown>, meta: ChannelMeta): Promise<Record<string, unknown>> => {
    verifyDingtalkSign(meta);
    const text = str(asRecord(payload.text), "content").trim();
    if (text === "") throw new RuntimeError("INVALID_INPUT", "钉钉回调缺少 text.content");
    const staffId = str(payload, "senderStaffId");
    const nick = str(payload, "senderNick");
    const from = staffId !== "" ? "钉钉:" + staffId : "钉钉:" + (nick || "unknown");
    const safeFrom = (staffId !== "" ? staffId : nick || "unknown").replace(/[^A-Za-z0-9_.:-]/g, "_");
    logEvent("dingtalk", from, "in", text);
    touch("dingtalk");
    const reply = await callAgent("dingtalk-" + safeFrom, text);
    logEvent("dingtalk", from, "out", reply);
    // 企业内部机器人官方协议：HTTP 响应体即回复消息（同步回包）。
    return { ok: true, channel: "dingtalk", from, reply, delivered: true, rawBody: { msgtype: "text", text: { content: reply } } };
  };

  const feishuBase = () => cfg.channelFeishuApiBase.replace(/\/+$/, "");

  const sendFeishuReply = async (chatId: string, reply: string): Promise<void> => {
    if (cfg.channelFeishuAppId === "") {
      throw new RuntimeError("RESOURCE_UNAVAILABLE", "飞书应用未配置（CORDIBANK_CHANNEL_FEISHU_APP_ID），无法送回回复");
    }
    const tokenRes = await postJson(feishuBase() + "/open-apis/auth/v3/tenant_access_token/internal", {
      app_id: cfg.channelFeishuAppId,
      app_secret: cfg.channelFeishuAppSecret,
    });
    const accessToken = str(tokenRes, "tenant_access_token");
    if (accessToken === "") throw new RuntimeError("RESOURCE_UNAVAILABLE", "飞书 tenant_access_token 获取失败：" + str(tokenRes, "msg"));
    const sendRes = await postJson(
      feishuBase() + "/open-apis/im/v1/messages?receive_id_type=chat_id",
      { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: reply }) },
      { authorization: "Bearer " + accessToken },
    );
    if (Number(sendRes.code) !== 0) {
      throw new RuntimeError("RESOURCE_UNAVAILABLE", "飞书消息发送失败：" + str(sendRes, "msg"));
    }
  };

  const handleFeishu = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const header = asRecord(payload.header);
    const token = str(header, "token") || str(payload, "token");
    if (cfg.channelFeishuToken !== "" && token !== cfg.channelFeishuToken) {
      throw new RuntimeError("ACCESS_DENIED", "飞书校验令牌不匹配");
    }
    // 官方 URL 验证：原样回传 challenge（server.ts 识别 rawBody 后按官方格式直返）。
    if (payload.type === "url_verification") {
      return { ok: true, channel: "feishu", rawBody: { challenge: str(payload, "challenge") } };
    }
    if (str(header, "event_type") !== "im.message.receive_v1") return { ok: true, channel: "feishu", ignored: true };
    const event = asRecord(payload.event);
    const message = asRecord(event.message);
    if (str(message, "message_type") !== "text") return { ok: true, channel: "feishu", ignored: true };
    let text = "";
    try {
      text = str(asRecord(JSON.parse(str(message, "content"))), "text");
    } catch {
      text = str(message, "content");
    }
    // 群聊 @机器人 会留下 @_user_N 占位，剔除后再进会话。
    text = text.replace(/@_user_\d+/g, "").trim();
    if (text === "") return { ok: true, channel: "feishu", ignored: true };
    const chatId = str(message, "chat_id");
    const openId = str(asRecord(asRecord(event.sender).sender_id), "open_id");
    const from = "飞书:" + (openId !== "" ? openId : chatId || "unknown");
    logEvent("feishu", from, "in", text);
    touch("feishu");
    const reply = await callAgent("feishu-" + (chatId !== "" ? chatId : openId).replace(/[^A-Za-z0-9_.:-]/g, "_"), text);
    logEvent("feishu", from, "out", reply);
    await sendFeishuReply(chatId, reply);
    return { ok: true, channel: "feishu", from, reply, delivered: true };
  };

  /** OpenClaw 网关 hooks 兼容入口：鉴权与载荷形状对齐官方 /hooks/agent 约定。 */
  const handleOpenclaw = async (payload: Record<string, unknown>, meta: ChannelMeta): Promise<Record<string, unknown>> => {
    if (cfg.channelOpenclawToken === "") {
      throw new RuntimeError("ACCESS_DENIED", "OpenClaw hook 令牌未配置（CORDIBANK_CHANNEL_OPENCLAW_TOKEN）");
    }
    const auth = meta.authorization ?? "";
    const provided = (meta["x-openclaw-token"] ?? (auth.startsWith("Bearer ") ? auth.slice(7) : "")) || str(payload, "token");
    if (provided !== cfg.channelOpenclawToken) {
      throw new RuntimeError("ACCESS_DENIED", "OpenClaw 令牌不匹配");
    }
    const message = str(payload, "message").trim() || str(payload, "text").trim();
    if (message === "") throw new RuntimeError("INVALID_INPUT", "OpenClaw 上报需要非空 message 字段");
    const from = str(payload, "from").trim() || str(payload, "name").trim() || "openclaw-user";
    const safeFrom = from.replace(/[^A-Za-z0-9_.:-]/g, "_");
    logEvent("openclaw", "微信:" + from, "in", message);
    touch("openclaw");
    const reply = await callAgent("openclaw-" + safeFrom, message);
    logEvent("openclaw", "微信:" + from, "out", reply);
    return { ok: true, channel: "openclaw", from, reply, delivered: true };
  };

  const view = (id: string, name: string, description: string, state: ChannelState): ChannelView => {
    const entry = counters.get(id);
    return {
      id,
      name,
      description,
      state: entry === undefined ? state : "active",
      messageCount: entry?.count ?? 0,
      ...(entry?.lastAt ? { lastMessageAt: entry.lastAt } : {}),
    };
  };

  return {
    name: "channels",
    def: {
      service: "channel.hub",
      methods: ["status", "incoming"],
      description: "渠道接入中心：微信（OpenClaw 网关）、QQ（OneBot v11 上报）、钉钉/飞书官方回调与通用 webhook 桥，回复由银行 Agent 会话生成。",
    },
    provider: {
      status: (): ChannelsStatus => ({
        channels: [
          view("web", "网页控制台", "CordiSwarm 控制台直连 RPC 与 SSE 流式", "active"),
          view("desktop", "桌面应用", "Windows 桌面壳内嵌同一控制台", "active"),
          view("openclaw", "微信（OpenClaw）", "OpenClaw 网关 hooks 兼容入口，Bearer 令牌鉴权，POST /channel/openclaw/incoming", cfg.channelOpenclawToken === "" ? "unconfigured" : "ready"),
          view("qq", "QQ", "OneBot v11 HTTP 上报（NapCat/Lagrange），私聊与群聊", cfg.channelQqApiUrl === "" ? "unconfigured" : "ready"),
          view("dingtalk", "钉钉", "企业内部机器人官方回调，sign 加签验签，同步回包", cfg.channelDingtalkSecret === "" ? "unconfigured" : "ready"),
          view("feishu", "飞书", "事件订阅官方回调，challenge 握手 + tenant_access_token 送回", cfg.channelFeishuAppId === "" ? "unconfigured" : "ready"),
          view("webhook", "通用 webhook 桥", "POST /channel/webhook/incoming，由桥接程序送回", "ready"),
        ],
        events: [...events].reverse(),
      }),
      incoming: async (channel: unknown, payload: unknown, meta?: unknown): Promise<Record<string, unknown>> => {
        const name = typeof channel === "string" ? channel : "";
        if (!CHANNEL_IDS.has(name)) throw new RuntimeError("NOT_FOUND", "未知渠道：" + name);
        if (payload === null || typeof payload !== "object") {
          throw new RuntimeError("INVALID_INPUT", "上报负载必须是 JSON 对象");
        }
        const record = payload as Record<string, unknown>;
        const headers: ChannelMeta = meta !== null && typeof meta === "object" ? (meta as ChannelMeta) : {};
        if (name === "onebot") return handleOnebot(record);
        if (name === "dingtalk") return handleDingtalk(record, headers);
        if (name === "feishu") return handleFeishu(record);
        if (name === "openclaw") return handleOpenclaw(record, headers);
        return handleWebhook(record);
      },
    },
  };
}