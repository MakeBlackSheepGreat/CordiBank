/**
 * QQ 官方机器人开放平台客户端（凭证式接入，不走 NapCat / OneBot）。
 *
 * 与微信 ilink 的扫码接入不同，QQ 官方机器人不需要扫码：
 * 在 QQ 开放平台创建机器人后拿到 AppID 与 AppSecret，后端用它换 access_token，
 * 再经 WebSocket 长连接收事件、经 OpenAPI 发消息。
 *
 * 协议要点：
 * - 取凭证 POST /app/getAppAccessToken，body {appId, clientSecret}，返回 {access_token, expires_in}；
 * - 鉴权头 Authorization: QQBot <access_token>；
 * - 网关 GET /gateway 返回 {url}，连上先收 op 10 HELLO，再发 op 2 IDENTIFY；
 * - 事件订阅位 GROUP_AND_C2C_EVENT = 1 << 25，事件名 GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE；
 * - 发消息 POST /v2/groups/{group_openid}/messages 或 POST /v2/users/{user_openid}/messages，
 *   被动回复需带 msg_id 与递增的 msg_seq。
 */
import { RuntimeError } from "../core/errors.ts";

/** QQ 开放平台接口域名（官方文档：所有接口调用域名统一为 api.bot.qq.com）。 */
export const DEFAULT_QQBOT_API_BASE = "https://api.bot.qq.com";
/** 机器人管理端，界面提示用户去这里创建机器人取 AppID。 */
export const QQ_OFFICIAL_PORTAL_URL = "https://q.qq.com/qqbot/";
/** 群 @机器人 与单聊等事件共用这一个订阅位。 */
export const QQ_INTENTS_GROUP_AND_C2C = 1 << 25;
/** 普通接口超时。 */
const HTTP_TIMEOUT_MS = 15000;
/** 网关握手超时。 */
const GATEWAY_TIMEOUT_MS = 15000;
/** 单条文本上限，超过即截断。 */
const MAX_CONTENT_CHARS = 2000;
/** access_token 提前刷新的余量。 */
const TOKEN_REFRESH_MARGIN_MS = 300_000;

/** access_token 及其有效期。 */
export interface QqBotCredential {
  accessToken: string;
  expiresIn: number;
}

/** 一条来自 QQ 的用户消息。 */
export interface QqBotMessage {
  /** 事件名，GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE 等。 */
  eventType: string;
  /** 消息正文（已剔除 @ 占位）。 */
  content: string;
  /** 群聊 openid，单聊为空串。 */
  groupOpenid: string;
  /** 用户 openid。 */
  userOpenid: string;
  /** 消息 id，被动回复时回传。 */
  messageId: string;
  /** 服务端时间戳（ISO 字符串）。 */
  timestamp: string;
}

/** 连接状态回调。 */
export type QqBotState = "connecting" | "open" | "closed";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function trimBase(apiBase: string): string {
  const normalized = apiBase.trim() === "" ? DEFAULT_QQBOT_API_BASE : apiBase.trim();
  return normalized.replace(/\/+$/, "");
}

function clip(text: string): string {
  return text.length > MAX_CONTENT_CHARS ? text.slice(0, MAX_CONTENT_CHARS) : text;
}

async function requestJson(
  method: "GET" | "POST",
  url: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new RuntimeError("RESOURCE_UNAVAILABLE", "QQ 开放平台回包不是 JSON：" + text.slice(0, 200));
  }
  return asRecord(parsed);
}

/** 错误回包统一按 code / message 判定。 */
function failHint(json: Record<string, unknown>, fallback: string): string {
  const message = str(json, "message");
  const code = json.code;
  const suffix = code === undefined ? "" : "（code " + String(code) + "）";
  return (message === "" ? fallback : message) + suffix;
}

/** 用 AppID 与 AppSecret 换 access_token。 */
export async function fetchAccessToken(apiBase: string, appId: string, clientSecret: string): Promise<QqBotCredential> {
  const id = appId.trim();
  const secret = clientSecret.trim();
  if (id === "" || secret === "") {
    throw new RuntimeError("INVALID_INPUT", "请填写 QQ 机器人的 AppID 与 AppSecret");
  }
  const json = await requestJson("POST", trimBase(apiBase) + "/app/getAppAccessToken", { appId: id, clientSecret: secret });
  const accessToken = str(json, "access_token");
  if (accessToken === "") {
    throw new RuntimeError("ACCESS_DENIED", "QQ 机器人凭证校验失败：" + failHint(json, "未返回 access_token"));
  }
  const expiresIn = Number(json.expires_in);
  return { accessToken, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200 };
}

/** 取 WebSocket 网关地址。 */
export async function fetchGatewayUrl(apiBase: string, accessToken: string): Promise<string> {
  const json = await requestJson("GET", trimBase(apiBase) + "/gateway", undefined, {
    authorization: "QQBot " + accessToken,
  });
  const url = str(json, "url");
  if (url === "") throw new RuntimeError("RESOURCE_UNAVAILABLE", "QQ 机器人网关地址获取失败：" + failHint(json, "未返回 url"));
  return url;
}

async function postMessage(
  apiBase: string,
  accessToken: string,
  path: string,
  content: string,
  messageId: string,
  msgSeq: number,
): Promise<void> {
  const text = clip(content.trim());
  if (text === "") throw new RuntimeError("INVALID_INPUT", "回复内容不能为空");
  const body: Record<string, unknown> = { content: text, msg_type: 0 };
  // 被动回复必须带 msg_id，并用递增的 msg_seq 支持对同一条消息多次回复。
  if (messageId !== "") {
    body.msg_id = messageId;
    body.msg_seq = msgSeq;
  }
  const json = await requestJson("POST", trimBase(apiBase) + path, body, { authorization: "QQBot " + accessToken });
  const code = json.code;
  if (code !== undefined && Number(code) !== 0) {
    throw new RuntimeError("RESOURCE_UNAVAILABLE", "QQ 消息发送失败：" + failHint(json, "未知错误"));
  }
}

/** 发群聊文本。 */
export async function sendGroupText(
  apiBase: string,
  accessToken: string,
  groupOpenid: string,
  content: string,
  messageId: string,
  msgSeq: number,
): Promise<void> {
  if (groupOpenid === "") throw new RuntimeError("INVALID_INPUT", "缺少群 openid");
  await postMessage(apiBase, accessToken, "/v2/groups/" + encodeURIComponent(groupOpenid) + "/messages", content, messageId, msgSeq);
}

/** 发单聊文本。 */
export async function sendC2CText(
  apiBase: string,
  accessToken: string,
  userOpenid: string,
  content: string,
  messageId: string,
  msgSeq: number,
): Promise<void> {
  if (userOpenid === "") throw new RuntimeError("INVALID_INPUT", "缺少用户 openid");
  await postMessage(apiBase, accessToken, "/v2/users/" + encodeURIComponent(userOpenid) + "/messages", content, messageId, msgSeq);
}

/** 网关帧里与业务相关的事件名。 */
const MESSAGE_EVENTS = new Set(["GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE", "GROUP_MSG_RECEIVE", "DIRECT_MESSAGE_CREATE"]);

/** 运行时内置 WebSocket 的最小结构，避免依赖 DOM 类型。 */
interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
}

type WsCtor = new (url: string) => WsLike;

function webSocketCtor(): WsCtor {
  const ctor = (globalThis as unknown as { WebSocket?: WsCtor }).WebSocket;
  if (ctor === undefined) {
    throw new RuntimeError("RESOURCE_UNAVAILABLE", "当前 Node 运行时没有内置 WebSocket（需要 Node 22 及以上）");
  }
  return ctor;
}

/** 从事件体抽一条可回复的消息。 */
function toMessage(eventType: string, data: unknown): QqBotMessage | undefined {
  if (!MESSAGE_EVENTS.has(eventType)) return undefined;
  const record = asRecord(data);
  const author = asRecord(record.author);
  const rawContent = str(record, "content");
  const content = rawContent.replace(/<@!?\d+>/g, "").trim();
  if (content === "") return undefined;
  const userOpenid = str(author, "user_openid") || str(author, "member_openid") || str(author, "id");
  const ts = Number(record.timestamp);
  return {
    eventType,
    content,
    groupOpenid: str(record, "group_openid"),
    userOpenid,
    messageId: str(record, "id"),
    timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : new Date().toISOString(),
  };
}

/** QQ 机器人长连接会话：负责鉴权、心跳、重连与事件分发。 */
export class QqBotSession {
  private readonly apiBase: string;
  private readonly appId: string;
  private readonly clientSecret: string;
  private readonly onMessage: (message: QqBotMessage) => void | Promise<void>;
  private readonly onState: (state: QqBotState, reason: string) => void;
  private socket: WsLike | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readyWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private accessToken = "";
  private tokenExpiresAt = 0;
  private seq = 0;
  private stopped = false;
  private open = false;
  private attempts = 0;

  constructor(options: {
    apiBase: string;
    appId: string;
    clientSecret: string;
    onMessage: (message: QqBotMessage) => void | Promise<void>;
    onState: (state: QqBotState, reason: string) => void;
  }) {
    this.apiBase = options.apiBase;
    this.appId = options.appId.trim();
    this.clientSecret = options.clientSecret.trim();
    this.onMessage = options.onMessage;
    this.onState = options.onState;
  }

  /** 当前是否已完成 READY 握手。 */
  get connected(): boolean {
    return this.open;
  }

  /** 取可用 access_token，临近过期时自动刷新。 */
  async currentToken(): Promise<string> {
    if (this.accessToken !== "" && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.accessToken;
    }
    const credential = await fetchAccessToken(this.apiBase, this.appId, this.clientSecret);
    this.accessToken = credential.accessToken;
    this.tokenExpiresAt = Date.now() + credential.expiresIn * 1000;
    return this.accessToken;
  }

  /** 建立连接并等到 READY；失败抛错。 */
  async connect(): Promise<void> {
    if (this.appId === "" || this.clientSecret === "") {
      throw new RuntimeError("INVALID_INPUT", "请先保存 QQ 机器人的 AppID 与 AppSecret");
    }
    this.stopped = false;
    this.onState("connecting", "");
    const token = await this.currentToken();
    const url = await fetchGatewayUrl(this.apiBase, token);
    const ctor = webSocketCtor();
    const socket = new ctor(url);
    this.socket = socket;
    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
    });
    socket.addEventListener("message", (event) => {
      this.handleFrame(event.data);
    });
    socket.addEventListener("close", () => {
      this.open = false;
      this.stopHeartbeat();
      if (this.stopped) return;
      this.scheduleReconnect("与 QQ 网关的连接已断开");
    });
    socket.addEventListener("error", () => {
      // 具体错误码由随后的 close 事件处理。
    });
    const timer = setTimeout(() => {
      if (this.readyWaiter !== undefined) {
        const waiter = this.readyWaiter;
        this.readyWaiter = undefined;
        waiter.reject(new RuntimeError("RESOURCE_UNAVAILABLE", "QQ 机器人网关握手超时（15 秒）"));
      }
    }, GATEWAY_TIMEOUT_MS);
    try {
      await ready;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 主动断开，不再重连。 */
  disconnect(): void {
    this.stopped = true;
    this.open = false;
    this.stopHeartbeat();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket !== undefined) {
      try {
        this.socket.close();
      } catch {
        // 关闭失败不影响状态复位。
      }
      this.socket = undefined;
    }
    this.onState("closed", "已断开");
  }

  private identify(): void {
    this.send({ op: 2, d: { token: "QQBot " + this.accessToken, intents: QQ_INTENTS_GROUP_AND_C2C, shard: [0, 1], properties: {} } });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket === undefined) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {
      // 发送失败等 close 事件统一重连。
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 45000;
    this.heartbeat = setInterval(() => {
      this.send({ op: 1, d: this.seq === 0 ? null : this.seq });
    }, period);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private handleFrame(data: unknown): void {
    const text = typeof data === "string" ? data : "";
    if (text === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const frame = asRecord(parsed);
    if (typeof frame.s === "number") this.seq = frame.s;
    const op = Number(frame.op);
    if (op === 10) {
      const interval = Number(asRecord(frame.d).heartbeat_interval);
      this.startHeartbeat(interval);
      this.identify();
      return;
    }
    if (op === 0) {
      const eventType = str(frame, "t");
      if (eventType === "READY") {
        this.open = true;
        this.attempts = 0;
        this.onState("open", "");
        if (this.readyWaiter !== undefined) {
          const waiter = this.readyWaiter;
          this.readyWaiter = undefined;
          waiter.resolve();
        }
        return;
      }
      const message = toMessage(eventType, frame.d);
      if (message !== undefined) void this.onMessage(message);
      return;
    }
    if (op === 7) {
      this.scheduleReconnect("服务端要求重连");
      return;
    }
    if (op === 9) {
      this.scheduleReconnect("会话失效，需要重新鉴权");
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.open = false;
    this.stopHeartbeat();
    if (this.reconnectTimer !== undefined) return;
    if (this.socket !== undefined) {
      try {
        this.socket.close();
      } catch {
        // 忽略关闭异常。
      }
      this.socket = undefined;
    }
    this.onState("closed", reason);
    const delay = Math.min(3000 * Math.pow(2, this.attempts), 60000);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      void this.connect().catch((error: unknown) => {
        this.onState("closed", error instanceof Error ? error.message : String(error));
      });
    }, delay);
  }
}
