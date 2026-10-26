#!/usr/bin/env node
// 银行外部服务：汇率与跨境换算。数据为固定演示汇率，不接实时行情。

import { runServer } from "./_server.mjs";

/** 以人民币为基准的演示中间价，单位：1 单位外币兑人民币。 */
const RATES = {
  CNY: 1,
  USD: 7.12,
  EUR: 7.74,
  JPY: 0.0475,
  HKD: 0.912,
  GBP: 9.05,
  SGD: 5.28,
  KRW: 0.00516,
  AUD: 4.68,
  CAD: 5.21,
  THB: 0.198,
};

const UPDATED_AT = "2026-10-26T09:30:00+08:00";

function normalize(code) {
  if (typeof code !== "string") throw new Error("币种必须是字符串");
  const upper = code.trim().toUpperCase();
  if (RATES[upper] === undefined) throw new Error(`不支持的币种：${code}`);
  return upper;
}

const tools = [
  {
    name: "list_currencies",
    description: "列出支持的币种与对人民币中间价",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler() {
      return {
        updatedAt: UPDATED_AT,
        base: "CNY",
        currencies: Object.entries(RATES).map(([code, rate]) => ({ code, cnyPerUnit: rate })),
      };
    },
  },
  {
    name: "get_rate",
    description: "查询两个币种之间的汇率",
    inputSchema: {
      type: "object",
      properties: { base: { type: "string" }, quote: { type: "string" } },
      required: ["base", "quote"],
      additionalProperties: false,
    },
    handler(args) {
      const base = normalize(args.base);
      const quote = normalize(args.quote);
      // 汇率表是「1 单位外币兑人民币」，所以 base 兑 quote 等于两者人民币价之比。
      const rate = RATES[base] / RATES[quote];
      return { base, quote, rate: Number(rate.toFixed(6)), updatedAt: UPDATED_AT };
    },
  },
  {
    name: "convert",
    description: "按演示汇率换算金额，返回两位小数",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number" },
        base: { type: "string" },
        quote: { type: "string" },
      },
      required: ["amount", "base", "quote"],
      additionalProperties: false,
    },
    handler(args) {
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount < 0) throw new Error("金额必须是非负数字");
      const base = normalize(args.base);
      const quote = normalize(args.quote);
      const rate = RATES[base] / RATES[quote];
      return {
        base,
        quote,
        rate: Number(rate.toFixed(6)),
        amount,
        converted: Number((amount * rate).toFixed(2)),
        updatedAt: UPDATED_AT,
      };
    },
  },
];

runServer({ name: "cordibank-fx", version: "1.0.0", tools });
