#!/usr/bin/env node
// 银行外部服务：理财产品目录、费率解释与适当性校验。

import { runServer } from "./_server.mjs";

const PRODUCTS = [
  { id: "p-001", name: "稳盈货币 A", riskLevel: 1, annualRateBp: 185, minAmountCents: 100, termDays: 0, feeBp: 0, issuer: "微众理财" },
  { id: "p-002", name: "安享 90 天", riskLevel: 2, annualRateBp: 268, minAmountCents: 100000, termDays: 90, feeBp: 15, issuer: "微众理财" },
  { id: "p-003", name: "平衡增利 180 天", riskLevel: 3, annualRateBp: 412, minAmountCents: 500000, termDays: 180, feeBp: 30, issuer: "微众理财" },
  { id: "p-004", name: "进取优选混合", riskLevel: 4, annualRateBp: 685, minAmountCents: 1000000, termDays: 365, feeBp: 60, issuer: "合作基金" },
  { id: "p-005", name: "科技成长主题", riskLevel: 5, annualRateBp: 940, minAmountCents: 1000000, termDays: 730, feeBp: 80, issuer: "合作基金" },
];

/** 风险等级的中文表述，供适当性结论使用。 */
const RISK_LABELS = { 1: "保守型", 2: "稳健型", 3: "平衡型", 4: "成长型", 5: "进取型" };

function findProduct(productId) {
  const product = PRODUCTS.find((item) => item.id === productId);
  if (product === undefined) throw new Error(`产品不存在：${String(productId)}`);
  return product;
}

const tools = [
  {
    name: "list_products",
    description: "列出在售理财产品与关键要素",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler() {
      return {
        count: PRODUCTS.length,
        products: PRODUCTS.map((item) => ({
          ...item,
          annualRate: `${(item.annualRateBp / 100).toFixed(2)}%`,
          riskLabel: RISK_LABELS[item.riskLevel],
        })),
      };
    },
  },
  {
    name: "explain_fee",
    description: "解释产品费率构成与到期收益估算",
    inputSchema: {
      type: "object",
      properties: { productId: { type: "string" }, amountCents: { type: "number" } },
      required: ["productId"],
      additionalProperties: false,
    },
    handler(args) {
      const product = findProduct(args.productId);
      const amount = Number(args.amountCents ?? product.minAmountCents);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("金额必须是正数");
      const fee = Math.round((amount * product.feeBp) / 10000);
      const gross = Math.round((amount * product.annualRateBp * product.termDays) / 10000 / 365);
      return {
        productId: product.id,
        name: product.name,
        managementFeeBp: product.feeBp,
        managementFeeCents: fee,
        estimatedGrossCents: gross,
        estimatedNetCents: gross - fee,
        note: product.termDays === 0 ? "活期产品，收益按日计提" : `持有 ${product.termDays} 天按票面年化估算`,
      };
    },
  },
  {
    name: "suitability",
    description: "适当性校验：判断客户风险等级能否购买该产品",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "string" },
        customerRiskLevel: { type: "number" },
        amountCents: { type: "number" },
      },
      required: ["productId", "customerRiskLevel"],
      additionalProperties: false,
    },
    handler(args) {
      const product = findProduct(args.productId);
      const level = Number(args.customerRiskLevel);
      if (!Number.isInteger(level) || level < 1 || level > 5) throw new Error("客户风险等级必须是 1 至 5 的整数");
      const amount = Number(args.amountCents ?? product.minAmountCents);
      const reasons = [];
      if (level < product.riskLevel) reasons.push(`产品风险等级 ${product.riskLevel} 高于客户承受等级 ${level}`);
      if (amount < product.minAmountCents) reasons.push("金额低于起购门槛");
      return {
        productId: product.id,
        customerRiskLevel: level,
        customerLabel: RISK_LABELS[level],
        productRiskLevel: product.riskLevel,
        productLabel: RISK_LABELS[product.riskLevel],
        suitable: reasons.length === 0,
        reasons,
        action: reasons.length === 0 ? "可以进入申购流程" : "需完成风险测评或更换产品",
      };
    },
  },
];

runServer({ name: "cordibank-catalog", version: "1.0.0", tools });
