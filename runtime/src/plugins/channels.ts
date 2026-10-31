import type { CapabilityPlugin } from "../capabilities/types.ts";
import type { RuntimeConfig } from "../config.ts";
import { RuntimeError } from "../core/errors.ts";

/**
 * 渠道接入中心：把 IM 渠道接进银行 Agent 会话。
 * - QQ：OneBot v11 HTTP 上报（NapCat/Lagrange 兼容），回复经 HTTP API 送回；
 * - 微信等：通用 webhook 桥，POST 进来即回 JSON，由桥负责送回；
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
const CHANNEL_IDS = new Set(["onebot", "webhook"]);

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

type PluginDeps = { get(id: string): CapabilityPlugin | undefined };

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

  const postToOnebot = async (path: string, body: Record<string, unknown>): Promise<void> => {
    if (cfg.channelQqApiUrl === "") {
      throw new RuntimeError("RESOURCE_UNAVAILABLE", "QQ API 未配置（CORDIBANK_CHANNEL_QQ_API），无法送回回复");
    }
    const base = cfg.channelQqApiUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cfg.channelQqToken !== "") headers.authorization = "Bearer " + cfg.channelQqToken;
    const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new RuntimeError("RESOURCE_UNAVAILABLE", "QQ API 回包异常：" + String(res.status));
  };

  const handleOnebot = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (cfg.channelQqToken !== "" && payload.token !== cfg.channelQqToken) {
      throw new RuntimeError("ACCESS_DENIED", "上报令牌不匹配");
    }
    const postType = typeof payload.post_type === "string" ? payload.post_type : "";
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
    const from = typeof payload.from === "string" && payload.from.trim() !== "" ? payload.from.trim() : "anonymous";
    const text = typeof payload.text === "string" ? payload.text : "";
    if (text.trim() === "") throw new RuntimeError("INVALID_INPUT", "webhook 上报需要非空 text 字段");
    const source = typeof payload.channel === "string" && payload.channel.trim() !== "" ? payload.channel.trim() : "wechat";
    // from 只用于会话键：限定字符集，防会话键注入。
    const safeFrom = from.replace(/[^A-Za-z0-9_.:-]/g, "_");
    logEvent(source, from, "in", text);
    touch(source);
    const reply = await callAgent("webhook-" + source + "-" + safeFrom, text);
    logEvent(source, from, "out", reply);
    return { ok: true, channel: source, from, reply };
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
      description: "渠道接入中心：QQ（OneBot v11 上报）与微信 webhook 桥，回复由银行 Agent 会话生成。",
    },
    provider: {
      status: (): ChannelsStatus => ({
        channels: [
          view("web", "网页控制台", "CordiSwarm 控制台直连 RPC 与 SSE 流式", "active"),
          view("desktop", "桌面应用", "Windows 桌面壳内嵌同一控制台", "active"),
          view("qq", "QQ", "OneBot v11 HTTP 上报（NapCat/Lagrange），私聊与群聊", cfg.channelQqApiUrl === "" ? "unconfigured" : "ready"),
          view("wechat", "微信（webhook 桥）", "POST /channel/webhook/incoming，由桥接程序送回", "ready"),
        ],
        events: [...events].reverse(),
      }),
      incoming: async (channel: unknown, payload: unknown): Promise<Record<string, unknown>> => {
        const name = typeof channel === "string" ? channel : "";
        if (!CHANNEL_IDS.has(name)) throw new RuntimeError("NOT_FOUND", "未知渠道：" + name);
        if (payload === null || typeof payload !== "object") {
          throw new RuntimeError("INVALID_INPUT", "上报负载必须是 JSON 对象");
        }
        const record = payload as Record<string, unknown>;
        return name === "onebot" ? handleOnebot(record) : handleWebhook(record);
      },
    },
  };
}
