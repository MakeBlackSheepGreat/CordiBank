/**
 * 渠道接入向导：把微信（ilink）与 QQ（官方机器人）的接入做进应用内。
 *
 * - 微信：后端向 ilink 取码 → 前端渲染二维码 → 长轮询登录态 → 落盘机器人令牌 → 起收发循环；
 * - QQ：应用内填 AppID / AppSecret → 后端换 access_token 并连官方 WebSocket 网关 →
 *   收 GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE → 银行 Agent 生成回复 → 官方 OpenAPI 送回。
 *
 * 两条链路都不需要外部窗口、bat 或第三方 WebUI，也不需要 NapCat。
 */
import type { CapabilityPlugin } from "../capabilities/types.ts";
import type { RuntimeConfig } from "../config.ts";
import { RuntimeError } from "../core/errors.ts";
import { applyUserSettings, writeUserSettings } from "../core/settings-store.ts";
import { extractText, fetchQrCode, getUpdates, pollQrStatus, sendText, type IlinkQr, type IlinkQrStatusView } from "../channels/ilink.ts";
import {
  DEFAULT_QQBOT_API_BASE,
  QQ_OFFICIAL_PORTAL_URL,
  QqBotSession,
  fetchAccessToken,
  sendC2CText,
  sendGroupText,
  type QqBotMessage,
} from "../channels/qqbot.ts";

type PluginDeps = { get(id: string): CapabilityPlugin | undefined };

/** 微信侧运行时视图。 */
export interface WechatWizardView {
  /** 是否已持有机器人令牌（扫码完成）。 */
  connected: boolean;
  accountId: string;
  /** 收发循环是否在跑。 */
  running: boolean;
  messageCount: number;
  lastMessageAt: string;
  error: string;
}

/** QQ 侧运行时视图。 */
export interface QqWizardView {
  /** 是否已保存 AppID 与 AppSecret。 */
  configured: boolean;
  appId: string;
  /** 长连接是否已完成鉴权握手。 */
  connected: boolean;
  messageCount: number;
  lastMessageAt: string;
  lastError: string;
  message: string;
  /** 机器人管理端地址，界面用于提示去哪取凭证。 */
  portalUrl: string;
}

/** 向导总视图。 */
export interface WizardState {
  wechat: WechatWizardView;
  qq: QqWizardView;
  /** 数据目录，界面用于展示落盘位置。 */
  dataDir: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** 会话键净化：只留可写字符，防会话键注入。 */
function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

/** 渠道接入向导插件。 */
export function createChannelWizardPlugin(cfg: RuntimeConfig, deps: PluginDeps): CapabilityPlugin {
  const dataDir = cfg.storeDir;
  let wechatRunning = false;
  let wechatCursor = "";
  let wechatMessageCount = 0;
  let wechatLastAt = "";
  let wechatError = "";
  let wechatStopRequested = false;
  let qqSession: QqBotSession | undefined;
  let qqMessageCount = 0;
  let qqLastAt = "";
  let qqLastError = "";
  let qqMessage = "";
  /** 同一 msg_id 的被动回复序号，官方要求递增且不可重复。 */
  const qqSeq = new Map<string, number>();

  const bankProvider = () => {
    const bank = deps.get("bank-agent");
    if (bank === undefined) throw new RuntimeError("RESOURCE_UNAVAILABLE", "渠道向导依赖的 bank-agent 插件未装载");
    return bank.provider;
  };

  /** 渠道事件直接记进渠道接入中心，界面上的消息计数与事件流才是真实的。 */
  const recordEvent = (channel: string, from: string, direction: "in" | "out", text: string): void => {
    const hub = deps.get("channels");
    if (hub === undefined) return;
    const record = hub.provider.record;
    if (typeof record !== "function") return;
    try {
      record(channel, from, direction, text);
    } catch {
      // 记账失败不影响收发主链路。
    }
  };

  /** 从 bank.agent.chat 回包抽正文（与 channels.ts 同口径）。 */
  const extractReply = (result: unknown): string => {
    const rec = asRecord(result);
    if (typeof rec.reply === "string") return rec.reply;
    const chat = asRecord(rec.chat);
    if (typeof chat.reply === "string") return chat.reply;
    const loop = asRecord(rec.loop);
    if (typeof loop.text === "string") return loop.text;
    return "";
  };

  const callAgent = async (sessionId: string, text: string): Promise<string> => {
    const reply = await bankProvider().chat(sessionId, text);
    return extractReply(reply);
  };

  /** 把扫码拿到的微信令牌落盘并就地生效。 */
  const persistWechat = (token: string, accountId: string): void => {
    const merged = writeUserSettings(cfg.storeDir, { channels: { wechatToken: token, wechatAccount: accountId } });
    applyUserSettings(cfg, merged);
  };

  /** 微信收发循环：长轮询收消息 → 银行 Agent → 原样带回 context_token 发回。 */
  const wechatLoop = async (): Promise<void> => {
    wechatRunning = true;
    wechatStopRequested = false;
    while (wechatStopRequested === false) {
      const token = cfg.channelWechatBotToken;
      if (token === "") break;
      try {
        const batch = await getUpdates(cfg.channelWechatBaseUrl, token, wechatCursor);
        wechatCursor = batch.cursor;
        wechatError = "";
        for (const message of batch.messages) {
          const text = extractText(message);
          if (text === "" || message.fromUserId === "") continue;
          wechatMessageCount += 1;
          wechatLastAt = new Date().toISOString();
          recordEvent("wechat", "微信:" + message.fromUserId, "in", text);
          const reply = await callAgent("wechat-" + safeKey(message.fromUserId), text);
          recordEvent("wechat", "微信:" + message.fromUserId, "out", reply);
          await sendText(cfg.channelWechatBaseUrl, token, message.fromUserId, reply, message.contextToken);
        }
      } catch (error) {
        wechatError = error instanceof Error ? error.message : String(error);
        // 出错退避 3 秒再续轮，避免打爆服务端。
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    wechatRunning = false;
  };

  const startWechat = (): void => {
    if (cfg.channelWechatBotToken === "") return;
    if (wechatRunning) return;
    void wechatLoop();
  };

  const stopWechat = (): void => {
    wechatStopRequested = true;
    wechatRunning = false;
  };

  const wechatView = (): WechatWizardView => ({
    connected: cfg.channelWechatBotToken !== "",
    accountId: cfg.channelWechatAccountId,
    running: wechatRunning,
    messageCount: wechatMessageCount,
    lastMessageAt: wechatLastAt,
    error: wechatError,
  });

  const qqApiBase = (): string => (cfg.channelQqBotApiBase === "" ? DEFAULT_QQBOT_API_BASE : cfg.channelQqBotApiBase);

  /** QQ 收到一条消息：银行 Agent 生成回复，再用官方 OpenAPI 送回原会话。 */
  const handleQqMessage = async (message: QqBotMessage): Promise<void> => {
    const session = qqSession;
    if (session === undefined) return;
    const isGroup = message.groupOpenid !== "";
    const from = isGroup ? "QQ群:" + message.groupOpenid : "QQ:" + message.userOpenid;
    const sessionId = isGroup ? "qq-group-" + safeKey(message.groupOpenid) : "qq-" + safeKey(message.userOpenid);
    qqMessageCount += 1;
    qqLastAt = new Date().toISOString();
    recordEvent("qq", from, "in", message.content);
    try {
      const token = await session.currentToken();
      const reply = await callAgent(sessionId, message.content);
      const seq = (qqSeq.get(message.messageId) ?? 0) + 1;
      if (qqSeq.size > 200) qqSeq.clear();
      qqSeq.set(message.messageId, seq);
      if (isGroup) {
        await sendGroupText(qqApiBase(), token, message.groupOpenid, reply, message.messageId, seq);
      } else {
        await sendC2CText(qqApiBase(), token, message.userOpenid, reply, message.messageId, seq);
      }
      recordEvent("qq", from, "out", reply);
      qqLastError = "";
    } catch (error) {
      qqLastError = error instanceof Error ? error.message : String(error);
    }
  };

  const stopQq = (): void => {
    if (qqSession === undefined) return;
    qqSession.disconnect();
    qqSession = undefined;
    qqSeq.clear();
  };

  const qqView = (): QqWizardView => ({
    configured: cfg.channelQqBotAppId !== "" && cfg.channelQqBotAppSecret !== "",
    appId: cfg.channelQqBotAppId,
    connected: qqSession !== undefined && qqSession.connected,
    messageCount: qqMessageCount,
    lastMessageAt: qqLastAt,
    lastError: qqLastError,
    message: qqMessage,
    portalUrl: QQ_OFFICIAL_PORTAL_URL,
  });

  return {
    name: "channel-wizard",
    def: {
      service: "channel.wizard",
      methods: ["state", "wechatQr", "wechatPoll", "wechatLogout", "qqSave", "qqConnect", "qqDisconnect"],
      description: "渠道接入向导：微信 ilink 扫码与 QQ 官方机器人凭证接入都在应用内完成，接入后收发链路自动起。",
    },
    provider: {
      state: (): WizardState => ({ wechat: wechatView(), qq: qqView(), dataDir }),

      /** 取微信登录二维码。 */
      wechatQr: async (): Promise<IlinkQr> => {
        return fetchQrCode(cfg.channelWechatBaseUrl, cfg.channelWechatBotToken === "" ? [] : [cfg.channelWechatBotToken]);
      },

      /** 轮询微信扫码状态；confirmed 时落盘并起收发循环。 */
      wechatPoll: async (qrcode: unknown, verifyCode?: unknown): Promise<IlinkQrStatusView> => {
        const code = typeof qrcode === "string" ? qrcode : "";
        if (code === "") throw new RuntimeError("INVALID_INPUT", "缺少二维码内容");
        const verify = typeof verifyCode === "string" ? verifyCode : "";
        const view = await pollQrStatus(cfg.channelWechatBaseUrl, code, verify);
        if (view.status === "confirmed" && view.botToken !== "") {
          persistWechat(view.botToken, view.accountId);
          if (view.baseUrl !== "") cfg.channelWechatBaseUrl = view.baseUrl;
          startWechat();
        }
        return view;
      },

      /** 退出微信接入：清令牌并停收发循环。 */
      wechatLogout: (): WizardState => {
        stopWechat();
        persistWechat("", "");
        return { wechat: wechatView(), qq: qqView(), dataDir };
      },

      /** 保存 QQ 机器人凭证：先用真实接口换 access_token 校验，通过才落盘。 */
      qqSave: async (appId: unknown, appSecret: unknown): Promise<QqWizardView> => {
        const id = typeof appId === "string" ? appId.trim() : "";
        const secret = typeof appSecret === "string" ? appSecret.trim() : "";
        if (id === "" || secret === "") throw new RuntimeError("INVALID_INPUT", "请填写 QQ 机器人的 AppID 与 AppSecret");
        stopQq();
        qqLastError = "";
        qqMessage = "正在校验 AppID 与 AppSecret…";
        try {
          await fetchAccessToken(qqApiBase(), id, secret);
        } catch (error) {
          qqMessage = "凭证校验失败";
          qqLastError = error instanceof Error ? error.message : String(error);
          throw error;
        }
        const merged = writeUserSettings(cfg.storeDir, { channels: { qqBotAppId: id, qqBotAppSecret: secret } });
        applyUserSettings(cfg, merged);
        qqMessage = "凭证已校验并保存";
        return qqView();
      },

      /** 连 QQ 官方 WebSocket 网关，开始收发。 */
      qqConnect: async (): Promise<QqWizardView> => {
        if (cfg.channelQqBotAppId === "" || cfg.channelQqBotAppSecret === "") {
          throw new RuntimeError("INVALID_INPUT", "请先填写并保存 QQ 机器人的 AppID 与 AppSecret");
        }
        stopQq();
        qqLastError = "";
        qqMessage = "正在连接 QQ 网关…";
        const session = new QqBotSession({
          apiBase: qqApiBase(),
          appId: cfg.channelQqBotAppId,
          clientSecret: cfg.channelQqBotAppSecret,
          onMessage: (message) => handleQqMessage(message),
          onState: (state, reason) => {
            if (state === "closed" && reason !== "" && reason !== "已断开") qqLastError = reason;
          },
        });
        qqSession = session;
        try {
          await session.connect();
        } catch (error) {
          qqSession = undefined;
          qqMessage = "连接失败";
          qqLastError = error instanceof Error ? error.message : String(error);
          throw error;
        }
        qqMessage = "已连接 QQ 网关";
        return qqView();
      },

      /** 断开 QQ 长连接。 */
      qqDisconnect: (): QqWizardView => {
        stopQq();
        qqMessage = "已断开 QQ 网关";
        return qqView();
      },
    },
    mount: (): void => {
      // 已有令牌（上次扫码留下的）时直接续起收发循环。
      startWechat();
    },
    unmount: (): void => {
      stopWechat();
      stopQq();
    },
  };
}
