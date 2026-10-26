#!/usr/bin/env node
// 银行外部服务：生日礼遇预订。读取套餐、下单、查询与取消，订单存于进程内存。

import { runServer } from "./_server.mjs";

/** 礼遇套餐：与本地工具目录保持一致，价格单位分。 */
const CATALOG = [
  { id: "gift-cake", name: "生日蛋糕（6 寸）", priceCents: 16800, leadDays: 2 },
  { id: "gift-flower", name: "鲜花花束（混合）", priceCents: 12800, leadDays: 1 },
  { id: "gift-combo", name: "蛋糕加鲜花组合", priceCents: 26800, leadDays: 2 },
  { id: "gift-premium", name: "星光礼盒（含手写贺卡）", priceCents: 39800, leadDays: 3 },
];

/** 订单表：进程内存储，重启即清空。 */
const orders = new Map();

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} 必须是非空字符串`);
  }
  return value.trim();
}

function findGift(giftId) {
  const gift = CATALOG.find((item) => item.id === giftId);
  if (gift === undefined) throw new Error(`套餐不存在：${giftId}`);
  return gift;
}

let sequence = 0;

const tools = [
  {
    name: "list_gifts",
    description: "列出可预订的生日礼遇套餐与提前预订天数",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    handler() {
      return {
        count: CATALOG.length,
        items: CATALOG.map((item) => ({ ...item, price: `${(item.priceCents / 100).toFixed(2)} 元` })),
      };
    },
  },
  {
    name: "place_order",
    description: "下单预订礼遇，返回订单号",
    inputSchema: {
      type: "object",
      properties: {
        giftId: { type: "string", enum: CATALOG.map((item) => item.id) },
        deliverDate: { type: "string", description: "送达日期，格式 YYYY-MM-DD" },
        note: { type: "string" },
      },
      required: ["giftId", "deliverDate"],
      additionalProperties: false,
    },
    handler(args) {
      const gift = findGift(requireString(args.giftId, "giftId"));
      const deliverDate = requireString(args.deliverDate, "deliverDate");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deliverDate)) throw new Error("送达日期格式必须是 YYYY-MM-DD");
      sequence += 1;
      const orderId = `ord-${String(sequence).padStart(4, "0")}`;
      const order = { orderId, giftId: gift.id, name: gift.name, priceCents: gift.priceCents, deliverDate, status: "placed", note: typeof args.note === "string" ? args.note : "" };
      orders.set(orderId, order);
      return order;
    },
  },
  {
    name: "get_order",
    description: "按订单号查询状态",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
      additionalProperties: false,
    },
    handler(args) {
      const orderId = requireString(args.orderId, "orderId");
      const order = orders.get(orderId);
      if (order === undefined) throw new Error(`订单不存在：${orderId}`);
      return order;
    },
  },
  {
    name: "cancel_order",
    description: "取消已下单的礼遇，送达前一天内不可取消",
    inputSchema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
      additionalProperties: false,
    },
    handler(args) {
      const orderId = requireString(args.orderId, "orderId");
      const order = orders.get(orderId);
      if (order === undefined) throw new Error(`订单不存在：${orderId}`);
      if (order.status === "cancelled") return order;
      order.status = "cancelled";
      return order;
    },
  },
];

runServer({ name: "cordibank-gift", version: "1.0.0", tools });
