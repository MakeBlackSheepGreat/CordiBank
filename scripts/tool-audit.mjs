// 全量工具真实执行审计：所有工具走模型循环同一个 createLoopExecutor 执行一遍。
// 用法：DEEPSEEK_API_KEY=... node scripts/tool-audit.mjs（web_search 需要 key，其余不需要）
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../runtime/dist/config.js";
import { BankStore } from "../runtime/dist/bank/data.js";
import { ToolRegistry } from "../runtime/dist/harness/registry.js";
import { builtinToolDescriptors } from "../runtime/dist/bank/builtin-tools.js";
import { createWebExtras, webToolDescriptors } from "../runtime/dist/bank/web-tools.js";
import { createOpsExtras, opsToolDescriptors } from "../runtime/dist/plugins/ops.js";
import { createLoopExecutor } from "../runtime/dist/bank/loop-tools.js";
import { createMcpPlugin } from "../runtime/dist/plugins/mcp.js";
import { flattenMcpResult } from "../runtime/dist/plugins/mcp-tools.js";

const base = path.join(process.cwd(), ".tool-audit-tmp");
mkdirSync(base, { recursive: true });
const tmp = mkdtempSync(path.join(base, "run-"));
const cfg = loadConfig({ storeDir: path.join(tmp, "store"), skillsDir: path.join(tmp, "skills"), opsDir: path.join(tmp, "ops") });
const store = new BankStore(cfg.storeDir);
const registry = new ToolRegistry();
registry.registerMany(builtinToolDescriptors());
registry.registerMany(webToolDescriptors(cfg));
registry.registerMany(opsToolDescriptors(cfg));

mkdirSync(cfg.storeDir, { recursive: true });
writeFileSync(
  path.join(cfg.storeDir, "mcp.json"),
  readFileSync("mcp/servers.json", "utf8").split("__MCP_DIR__").join(path.resolve("mcp").replace(/\\/g, "/"))
);
const mcp = createMcpPlugin(cfg);
const invoker = async (serverId, remoteName, args) => {
  try {
    const reply = (await mcp.provider.call(serverId, remoteName, args));
    const text = flattenMcpResult(reply.result);
    return { ok: true, message: text === "" ? "外部服务已返回空结果" : text };
  } catch (error) {
    return { ok: false, message: `外部服务调用失败：${error instanceof Error ? error.message : String(error)}` };
  }
};

const executor = createLoopExecutor(() => store.load(), invoker, { ...createOpsExtras(cfg), ...createWebExtras(cfg) });

// 连接四个 MCP 服务器（真实 stdio 子进程）。
const { servers: serverList } = await mcp.provider.list();
for (const server of serverList) {
  try { await mcp.provider.connect(server.id); } catch (error) { console.error("connect fail", server.id, String(error)); }
}

const state = store.load();
const subName = Array.isArray(state.subscriptions) && state.subscriptions.length > 0 ? (state.subscriptions[0].name ?? state.subscriptions[0].subscriptionName ?? "视频会员") : "视频会员";
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

const CASES = [
  ["query_balance", {}],
  ["analyze_bills", { period: "month" }],
  ["transfer", { payee: "王晓明", amountCents: 100 }],
  ["create_aa", { payee: "小李", amountCents: 100, shares: 2 }],
  ["schedule_transfer", { payee: "王晓明", amountCents: 100, at: "tomorrow" }],
  ["list_subscriptions", {}],
  ["cancel_subscription", { subscriptionName: subName }],
  ["list_cards", {}],
  ["lock_card", { cardId: "card-002" }],
  ["report_loss", { cardId: "card-001" }],
  ["apply_card", { purpose: "审计测试新卡" }],
  ["adjust_limit", { cardId: "card-002", amountCents: 20000 }],
  ["change_password", {}],
  ["freeze_account", {}],
  ["wealth_list", {}],
  ["wealth_risk", {}],
  ["wealth_purchase", { productId: "p-001", amountCents: 1000 }],
  ["wealth_redeem", { productId: "p-001", amountCents: 500 }],
  ["subscription_reminder", {}],
  ["birthday_lock", { amountCents: 10000, purpose: "审计测试" }],
  ["birthday_book", { gift: "cake", purpose: "审计测试" }],
  ["web_search", { query: "人民币对美元汇率中间价" }],
  ["web_fetch", { url: "https://example.com/" }],
  ["ops_run", { command: "node -p 1+1" }],
  ["mcp__bank-fx__list_currencies", {}],
  ["mcp__bank-fx__get_rate", { base: "USD", quote: "CNY" }],
  ["mcp__bank-fx__convert", { amount: 100, base: "USD", quote: "CNY" }],
  ["mcp__bank-risk__screen_payee", { name: "王晓明", account: "6222000011113333" }],
  ["mcp__bank-risk__fraud_signals", { account: "6222000011112222" }],
  ["mcp__bank-risk__credit_score", { userId: "user-001" }],
  ["mcp__bank-catalog__list_products", {}],
  ["mcp__bank-catalog__explain_fee", { productId: "p-002", amountCents: 100000 }],
  ["mcp__bank-catalog__suitability", { productId: "p-002", customerRiskLevel: 3 }],
  ["mcp__bank-gift__list_gifts", {}],
];

const rows = [];
for (const [name, args] of CASES) {
  const started = Date.now();
  let out;
  try { out = await executor(name, args); }
  catch (error) { out = { ok: false, summary: `执行器异常：${error instanceof Error ? error.message : String(error)}` }; }
  rows.push({ name, args, ok: out.ok === true, ms: Date.now() - started, summary: String(out.summary ?? "") });
}

// gift 订单有依赖：place -> get -> cancel，单独串在最后。
const placed = await executor("mcp__bank-gift__place_order", { giftId: "gift-cake", deliverDate: tomorrow });
rows.push({ name: "mcp__bank-gift__place_order", ok: placed.ok === true, ms: 0, summary: String(placed.summary ?? "") });
const orderId = (String(placed.summary).match(/(ord|order)-[A-Za-z0-9-]+/) ?? ["order-unknown"])[0];
const got = await executor("mcp__bank-gift__get_order", { orderId });
rows.push({ name: "mcp__bank-gift__get_order", ok: got.ok === true, ms: 0, summary: String(got.summary ?? "") });
const cancelled = await executor("mcp__bank-gift__cancel_order", { orderId });
rows.push({ name: "mcp__bank-gift__cancel_order", ok: cancelled.ok === true, ms: 0, summary: String(cancelled.summary ?? "") });

console.log("| 工具 | 结果 | 耗时 | 摘要 |");
console.log("|---|---|---|---|");
let bad = 0;
for (const row of rows) {
  const refused = !row.ok && /强验证/.test(row.summary);
  if (!row.ok && !refused) bad += 1;
  console.log(`| ${row.name} | ${row.ok ? "OK" : refused ? "REFUSED(设计使然)" : "FAIL"} | ${row.ms}ms | ${row.summary.slice(0, 80).replace(/\|/g, "/")} |`);
}
console.log("");
console.log(`TOTAL=${rows.length} FAIL=${bad}`);
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
