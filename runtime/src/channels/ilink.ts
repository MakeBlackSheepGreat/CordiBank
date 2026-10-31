import { randomBytes } from "node:crypto";

/**
 * 微信 ilink 官方接口客户端。
 *
 * 协议取自腾讯 @tencent-weixin/openclaw-weixin@2.4.10 的公开实现（MIT）：
 * - 取码 POST ilink/bot/get_bot_qrcode?bot_type=3，返回 qrcode 与 qrcode_img_content；
 * - 登录态 GET ilink/bot/get_qrcode_status，服务端长轮询，35s 超时返回 status=wait；
 * - 收消息 POST ilink/bot/getupdates，同样长轮询，带 get_updates_buf 游标；
 * - 发消息 POST ilink/bot/sendmessage，必须原样带回入站消息的 context_token。
 */

/** iLink-App-Id：取自插件 package.json 的 ilink_appid 字段。 */
const ILINK_APP_ID = "bot";
/** iLink-App-ClientVersion：0x00MMNNPP，对应 2.4.10。 */
const ILINK_APP_CLIENT_VERSION = ((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (10 & 0xff);
/** 上报的客户端标识，写入每条请求的 base_info.bot_agent。 */
const BOT_AGENT = "CordiBank";
/** 取码接口的机器人类型：3 为个人微信机器人。 */
const BOT_TYPE = 3;
/** 二维码登录态长轮询的客户端超时，必须与官方一致（服务端会挂住 35s）。 */
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
/** 收消息长轮询的客户端超时。 */
const UPDATES_LONG_POLL_TIMEOUT_MS = 35_000;
/** 普通接口超时。 */
const API_TIMEOUT_MS = 15_000;

/** 二维码取码结果。 */
export interface IlinkQr {
  qrcode: string;
  imageUrl: string;
}

/** 扫码登录状态：wait 未扫，scaned 已扫，need_verifycode 需要数字校验码。 */
export type IlinkQrStatus = "wait" | "scaned" | "need_verifycode" | "expired" | "confirmed" | "binded";

/** 一次登录态轮询的结果。 */
export interface IlinkQrStatusView {
  status: IlinkQrStatus;
  /** 登录确认后由服务端下发的机器人令牌。 */
  botToken: string;
  /** 登录确认后由服务端下发的机器人账号 id（ilink_bot_id）。 */
  accountId: string;
  /** 登录确认后由服务端下发的专属接口基址。 */
  baseUrl: string;
  /** 扫码用户的 ilink 用户 id。 */
  userId: string;
  /** 服务端附带的提示文案。 */
  message: string;
}

/** 入站消息（只保留收发需要的字段）。 */
export interface IlinkMessage {
  messageId: string;
  fromUserId: string;
  messageType: number;
  itemList: Array<Record<string, unknown>>;
  contextToken: string;
}

function ilinkHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64"),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
  if (token !== undefined && token !== "") headers.authorization = "Bearer " + token;
  return headers;
}

/** 每条请求都要带的客户端信息。 */
function baseInfo(): Record<string, unknown> {
  return { channel_version: "2.4.10", bot_agent: BOT_AGENT };
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function num(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

async function requestJson(
  url: string,
  init: { method: "GET" | "POST"; body?: unknown; token?: string; timeoutMs: number },
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: ilinkHeaders(init.token),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error("微信接口回包异常：" + String(res.status) + " " + text.slice(0, 200));
    }
    return asRecord(JSON.parse(text) as unknown);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取登录二维码。
 *
 * localTokenList 传已登录过的机器人令牌可让服务端直接返回 binded 态，首次接入传空数组。
 */
export async function fetchQrCode(baseUrl: string, localTokenList: string[] = []): Promise<IlinkQr> {
  const payload = await requestJson(
    trimBase(baseUrl) + "/ilink/bot/get_bot_qrcode?bot_type=" + String(BOT_TYPE),
    { method: "POST", body: { local_token_list: localTokenList.slice(0, 10) }, timeoutMs: API_TIMEOUT_MS },
  );
  const ret = num(payload, "ret");
  if (ret !== 0) {
    throw new Error("取二维码失败：ret=" + String(ret) + " " + str(payload, "errmsg"));
  }
  const qrcode = str(payload, "qrcode");
  const imageUrl = str(payload, "qrcode_img_content");
  if (qrcode === "" || imageUrl === "") {
    throw new Error("取二维码失败：回包缺少 qrcode 或 qrcode_img_content");
  }
  return { qrcode, imageUrl };
}

/** 服务端状态字到本地状态字的映射；两个 redirect 态都按已扫码处理。 */
function normalizeStatus(raw: string): IlinkQrStatus {
  if (raw === "binded_redirect") return "binded";
  if (raw === "scaned_but_redirect") return "scaned";
  if (raw === "wait" || raw === "scaned" || raw === "need_verifycode" || raw === "expired" || raw === "confirmed") {
    return raw;
  }
  return "wait";
}

/**
 * 轮询登录态。服务端长轮询，客户端超时按 wait 继续，不当作错误。
 */
export async function pollQrStatus(baseUrl: string, qrcode: string, verifyCode?: string): Promise<IlinkQrStatusView> {
  const query = "?qrcode=" + encodeURIComponent(qrcode) + (verifyCode === undefined || verifyCode === "" ? "" : "&verify_code=" + encodeURIComponent(verifyCode));
  let payload: Record<string, unknown>;
  try {
    payload = await requestJson(trimBase(baseUrl) + "/ilink/bot/get_qrcode_status" + query, {
      method: "GET",
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
    });
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "AbortError") {
      return { status: "wait", botToken: "", accountId: "", baseUrl: "", userId: "", message: "" };
    }
    throw err;
  }
  const status = normalizeStatus(str(payload, "status"));
  return {
    status,
    botToken: str(payload, "bot_token"),
    accountId: str(payload, "ilink_bot_id"),
    baseUrl: str(payload, "baseurl"),
    userId: str(payload, "ilink_user_id"),
    message: str(payload, "errmsg"),
  };
}

/** 长轮询收消息；客户端超时返回空批，调用方直接续轮。 */
export async function getUpdates(
  baseUrl: string,
  token: string,
  cursor: string,
): Promise<{ cursor: string; messages: IlinkMessage[] }> {
  let payload: Record<string, unknown>;
  try {
    payload = await requestJson(trimBase(baseUrl) + "/ilink/bot/getupdates", {
      method: "POST",
      token,
      body: { get_updates_buf: cursor, base_info: baseInfo() },
      timeoutMs: UPDATES_LONG_POLL_TIMEOUT_MS,
    });
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "AbortError") return { cursor, messages: [] };
    throw err;
  }
  const next = str(payload, "get_updates_buf");
  const rawList = payload.msgs;
  const messages: IlinkMessage[] = [];
  if (Array.isArray(rawList)) {
    for (const raw of rawList) {
      const record = asRecord(raw);
      const items = record.item_list;
      messages.push({
        messageId: str(record, "message_id"),
        fromUserId: str(record, "from_user_id"),
        messageType: num(record, "message_type"),
        itemList: Array.isArray(items) ? items.map((item) => asRecord(item)) : [],
        contextToken: str(record, "context_token"),
      });
    }
  }
  return { cursor: next === "" ? cursor : next, messages };
}

/** 从消息段里抽文本：只取 TEXT 段，其余类型忽略。 */
export function extractText(message: IlinkMessage): string {
  const parts: string[] = [];
  for (const item of message.itemList) {
    if (num(item, "type") !== 1) continue;
    const text = str(asRecord(item.text_item), "text");
    if (text !== "") parts.push(text);
  }
  return parts.join("").trim();
}

/** 发一条文本消息；context_token 必须带回，否则服务端无法定位会话。 */
export async function sendText(
  baseUrl: string,
  token: string,
  toUserId: string,
  text: string,
  contextToken: string,
): Promise<void> {
  const payload = await requestJson(trimBase(baseUrl) + "/ilink/bot/sendmessage", {
    method: "POST",
    token,
    timeoutMs: API_TIMEOUT_MS,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: "cordibank-" + randomBytes(8).toString("hex"),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        ...(contextToken === "" ? {} : { context_token: contextToken }),
      },
      base_info: baseInfo(),
    },
  });
  const ret = num(payload, "ret");
  if (ret !== 0) {
    throw new Error("发送消息失败：ret=" + String(ret) + " " + str(payload, "errmsg"));
  }
}
