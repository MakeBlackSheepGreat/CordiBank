#!/usr/bin/env node
// 银行外部服务：收款人筛查、反欺诈信号与征信评分。全部为合成判定，不接真实名单。

import { createHash } from "node:crypto";
import { runServer } from "./_server.mjs";

/** 演示用风险名单：命中即提升风险等级。 */
const WATCHLIST = ["6222020000000001", "6222020000000002", "6222020000006666"];

function stableScore(seed) {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  return digest[0] * 256 + digest[1];
}

function normalizeAccount(account) {
  if (typeof account !== "string" || account.trim() === "") {
    throw new Error("账号必须是非空字符串");
  }
  return account.replace(/\s+/g, "");
}

const tools = [
  {
    name: "screen_payee",
    description: "收款人风险筛查：返回风险等级、命中规则与建议动作",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        account: { type: "string" },
        amountCents: { type: "number" },
      },
      required: ["name", "account"],
      additionalProperties: false,
    },
    handler(args) {
      const account = normalizeAccount(args.account);
      const amount = Number(args.amountCents ?? 0);
      const hits = [];
      if (WATCHLIST.includes(account)) hits.push("命中涉诈名单");
      if (/^0{6,}$/.test(account.slice(-6))) hits.push("账号尾号异常");
      if (amount >= 50_000_00) hits.push("单笔金额偏高");
      const score = stableScore(account);
      const level = hits.length > 0 ? "high" : score < 60 ? "medium" : "low";
      const advice =
        level === "high"
          ? "拒绝交易并要求本人到柜面核验"
          : level === "medium"
            ? "要求二次确认并留存用途说明"
            : "可正常受理";
      return {
        name: typeof args.name === "string" ? args.name : "",
        accountTail: account.slice(-4),
        riskLevel: level,
        hits,
        advice,
      };
    },
  },
  {
    name: "fraud_signals",
    description: "查询账号近期的反欺诈信号",
    inputSchema: {
      type: "object",
      properties: { account: { type: "string" } },
      required: ["account"],
      additionalProperties: false,
    },
    handler(args) {
      const account = normalizeAccount(args.account);
      const score = stableScore(`signal:${account}`);
      const signals = [];
      if (score % 7 === 0) signals.push("短时间内多笔小额转入");
      if (score % 11 === 0) signals.push("异地设备登录");
      if (score % 13 === 0) signals.push("收款账户新开户");
      return {
        accountTail: account.slice(-4),
        signalCount: signals.length,
        signals,
        window: "近 30 天",
      };
    },
  },
  {
    name: "credit_score",
    description: "合成征信评分：返回分数、等级与主要影响因素",
    inputSchema: {
      type: "object",
      properties: { userId: { type: "string" } },
      required: ["userId"],
      additionalProperties: false,
    },
    handler(args) {
      const userId = typeof args.userId === "string" ? args.userId : "";
      if (userId.trim() === "") throw new Error("userId 必须是非空字符串");
      const raw = stableScore(`credit:${userId}`);
      const score = 550 + (raw % 300);
      const grade = score >= 800 ? "优秀" : score >= 700 ? "良好" : score >= 620 ? "一般" : "关注";
      return {
        userId,
        score,
        grade,
        factors: [
          { name: "履约记录", impact: score >= 700 ? "正向" : "中性" },
          { name: "负债水平", impact: score >= 650 ? "可控" : "偏高" },
          { name: "账户活跃度", impact: "正常" },
        ],
        updatedAt: "2026-10-20",
      };
    },
  },
];

runServer({ name: "cordibank-risk", version: "1.0.0", tools });
