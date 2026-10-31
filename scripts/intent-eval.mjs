// G2/G3 意图理解与槽位填充评测：120 条中文指令，跑规则层 parseIntent。
// 用法：node scripts/intent-eval.mjs（不需要 API key）
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../runtime/dist/config.js";
import { BankStore } from "../runtime/dist/bank/data.js";
import { parseIntent } from "../runtime/dist/bank/intent.js";

const base = path.join(process.cwd(), ".intent-eval-tmp");
mkdirSync(base, { recursive: true });
const tmp = mkdtempSync(path.join(base, "run-"));
const cfg = loadConfig({ storeDir: path.join(tmp, "store"), skillsDir: path.join(tmp, "skills") });
mkdirSync(cfg.storeDir, { recursive: true });
const state = new BankStore(cfg.storeDir).load();

// 每条：[文本, 期望场景, 期望工具|null, 期望槽位对象（值 "*" 表示仅需存在）, 期望缺失槽位数组]
const CASES = [
  // ---- C1 转账 24 条 ----
  ["给王晓明转 500 元", "transfer", "transfer", { payee: "王晓明", amountCents: 50000 }, []],
  ["转 300 块给李雷", "transfer", "transfer", { payee: "李雷", amountCents: 30000 }, []],
  ["向韩梅梅付款 1288.50 元", "transfer", "transfer", { payee: "韩梅梅", amountCents: 128850 }, []],
  ["给 13800138001 转 100 元", "transfer", "transfer", { payee: "王晓明", amountCents: 10000 }, []],
  ["给室友转 50 元", "transfer", "transfer", { payee: "李雷", amountCents: 5000 }, []],
  ["转五千块给张伟", "transfer", "transfer", { payee: "张伟", amountCents: 500000 }, []],
  ["给妈妈转五千块过生日", "cross", "birthday_lock", { amountCents: 500000, purpose: "*" }, []],
  ["给王晓明转账 300 元，备注房租", "transfer", "transfer", { payee: "王晓明", amountCents: 30000 }, []],
  ["帮我把 66 元打给赵敏", "transfer", "transfer", { payee: "赵敏", amountCents: 6600 }, []],
  ["给孙强汇款 800 元", "transfer", "transfer", { payee: "孙强", amountCents: 80000 }, []],
  ["转 10 元给陈静", "transfer", "transfer", { payee: "陈静", amountCents: 1000 }, []],
  ["给小王转 88 元", "transfer", "transfer", { payee: "王晓明", amountCents: 8800 }, []],
  ["明天给李雷转 200 元", "transfer", "schedule_transfer", { payee: "李雷", amountCents: 20000, at: "tomorrow" }, []],
  ["预约给张伟转 1500 元", "transfer", "schedule_transfer", { payee: "张伟", amountCents: 150000 }, []],
  ["下个月自动转 1000 元房租给张伟", "transfer", "schedule_transfer", { payee: "张伟", amountCents: 100000, at: "next-month" }, []],
  ["定时转 200 元给韩梅梅", "transfer", "schedule_transfer", { payee: "韩梅梅", amountCents: 20000 }, []],
  ["每月 1 号给张伟转 2000 元", "transfer", "schedule_transfer", { payee: "张伟", amountCents: 200000 }, []],
  ["和王晓明 AA 500 元 3 个人", "transfer", "create_aa", { payee: "王晓明", amountCents: 50000, shares: 3 }, []],
  ["这顿饭 240 元和刘洋平摊", "transfer", "create_aa", { payee: "刘洋", amountCents: 24000 }, []],
  ["AA 收款 300 元，两个人", "transfer", "create_aa", { amountCents: 30000, shares: 2 }, []],
  ["给张伟转点钱", "transfer", "transfer", {}, ["amountCents"]],
  ["转 500 元", "transfer", "transfer", {}, ["payee"]],
  ["AA 300 元", "transfer", "create_aa", {}, ["payee"]],
  ["预约转账 800 元", "transfer", "schedule_transfer", {}, ["payee"]],
  // ---- C2 账单 16 条 ----
  ["帮我分析这个月的账单", "bills", "analyze_bills", {}, []],
  ["看看我的消费情况", "bills", "analyze_bills", {}, []],
  ["这个月花了多少钱", "bills", "analyze_bills", {}, []],
  ["生成本月支出报告", "bills", "analyze_bills", {}, []],
  ["有没有异常交易", "bills", "analyze_bills", {}, []],
  ["查一下上个月的流水", "bills", "analyze_bills", { period: "*" }, []],
  ["上个月账单汇总", "bills", "analyze_bills", { period: "*" }, []],
  ["最近消费统计一下", "bills", "analyze_bills", {}, []],
  ["我的账单里有什么大额支出吗", "bills", "analyze_bills", {}, []],
  ["分析下开销", "bills", "analyze_bills", {}, []],
  ["查余额", "bills", "query_balance", {}, []],
  ["我还有多少钱", "bills", "query_balance", {}, []],
  ["账户余额是多少", "bills", "query_balance", {}, []],
  ["可用额度还剩多少", "card", "list_cards", {}, []],
  ["看看卡里还有多少钱", "bills", "query_balance", {}, []],
  ["余额", "bills", "query_balance", {}, []],
  // ---- C3 理财 18 条 ----
  ["做一次风险测评", "wealth", "wealth_risk", {}, []],
  ["我的风险等级是多少", "wealth", "wealth_risk", {}, []],
  ["评估下我的风险承受能力", "wealth", "wealth_risk", {}, []],
  ["有哪些理财产品", "wealth", "wealth_list", {}, []],
  ["推荐几个稳健的理财", "wealth", "wealth_list", {}, []],
  ["对比一下稳盈货币 A 和安享 90 天", "wealth", "wealth_list", {}, []],
  ["稳盈货币 A 的收益怎么样", "wealth", "wealth_list", { productId: "*" }, []],
  ["查理财行情", "wealth", "wealth_list", {}, []],
  ["有什么基金可以买", "wealth", "wealth_list", {}, []],
  ["申购 稳盈货币 A 1000 元", "wealth", "wealth_purchase", { productId: "*", amountCents: 100000 }, []],
  ["买 500 元稳盈货币 A", "wealth", "wealth_purchase", { productId: "*", amountCents: 50000 }, []],
  ["申购安享 90 天 五万元", "wealth", "wealth_purchase", { productId: "*", amountCents: 5000000 }, []],
  ["我想买点理财，预算一万", "wealth", "wealth_purchase", { amountCents: 1000000 }, []],
  ["赎回 稳盈货币 A 500 元", "wealth", "wealth_redeem", { productId: "*", amountCents: 50000 }, []],
  ["把安享 90 天全赎回来", "wealth", "wealth_redeem", { productId: "*" }, []],
  ["赎回 200 块稳盈货币 A", "wealth", "wealth_redeem", { productId: "*", amountCents: 20000 }, []],
  ["帮我赎回一点理财", "wealth", "wealth_redeem", {}, []],
  ["买 500 元稳盈货币A，急", "wealth", "wealth_purchase", { productId: "*", amountCents: 50000 }, []],
  // ---- C4 卡片 22 条 ----
  ["我的卡丢了", "card", "report_loss", { cardId: "card-001" }, []],
  ["银行卡挂失", "card", "report_loss", { cardId: "card-001" }, []],
  ["信用卡遗失了，帮我挂失", "card", "report_loss", { cardId: "card-001" }, []],
  ["卡不见了怎么办", "card", "report_loss", { cardId: "card-001" }, []],
  ["把尾号 8899 的卡锁了", "card", "lock_card", { cardId: "card-002" }, []],
  ["锁卡", "card", "lock_card", { cardId: "card-002" }, []],
  ["冻结我的卡片", "card", "lock_card", { cardId: "card-002" }, []],
  ["先锁卡保证安全", "card", "lock_card", { cardId: "card-002" }, []],
  ["帮我解锁银行卡", "card", "lock_card", { cardId: "card-002", note: "unlock" }, []],
  ["恢复卡片使用", "card", "lock_card", { cardId: "card-002", note: "unlock" }, []],
  ["把额度调到 5000 元", "card", "adjust_limit", { cardId: "card-002", amountCents: 500000 }, []],
  ["限额改成 300 块", "card", "adjust_limit", { cardId: "card-002", amountCents: 30000 }, []],
  ["调整额度为两万元", "card", "adjust_limit", { cardId: "card-002", amountCents: 2000000 }, []],
  ["单日限额设为 1000 元", "card", "adjust_limit", { cardId: "card-002", amountCents: 100000 }, []],
  ["我想申请一张新卡", "card", "apply_card", { purpose: "*" }, []],
  ["办一张信用卡", "card", "apply_card", { purpose: "*" }, []],
  ["给我办理新卡", "card", "apply_card", { purpose: "*" }, []],
  ["申请卡需要什么材料", "card", "apply_card", { purpose: "*" }, []],
  ["查一下我的卡片状态", "card", "list_cards", {}, []],
  ["名下有哪些卡", "card", "list_cards", {}, []],
  ["修改支付密码", "card", "change_password", {}, []],
  ["把登录密码换掉", "card", "change_password", {}, []],
  // ---- C5 订阅 14 条 ----
  ["取消云幕视频会员", "subscription", "cancel_subscription", { subscriptionName: "云幕视频会员" }, []],
  ["帮我退订声浪音乐会员", "subscription", "cancel_subscription", { subscriptionName: "声浪音乐会员" }, []],
  ["把方圆云盘的自动扣费关掉", "subscription", "cancel_subscription", { subscriptionName: "方圆云盘" }, []],
  ["取消订阅财经早报", "subscription", "cancel_subscription", { subscriptionName: "财经早报" }, []],
  ["退订工具箱 Pro", "subscription", "cancel_subscription", { subscriptionName: "工具箱 Pro" }, []],
  ["我要取消悦动健身月卡的续费", "subscription", "cancel_subscription", { subscriptionName: "悦动健身月卡" }, []],
  ["最近有什么订阅在扣费", "subscription", "list_subscriptions", {}, []],
  ["查一下我的代扣项目", "subscription", "list_subscriptions", {}, []],
  ["列出所有会员订阅", "subscription", "list_subscriptions", {}, []],
  ["我的自动扣费有哪些", "subscription", "list_subscriptions", {}, []],
  ["下期扣费是什么时候", "subscription", "subscription_reminder", {}, []],
  ["最近有续费提醒吗", "subscription", "subscription_reminder", {}, []],
  ["订阅扣费日历", "subscription", "subscription_reminder", {}, []],
  ["提醒我哪些订阅快到期", "subscription", "subscription_reminder", {}, []],
  // ---- C6 生日联动 10 条 ----
  ["妈妈快过生日了，锁定 1000 元准备礼物", "cross", "birthday_lock", { amountCents: 100000 }, []],
  ["锁定 500 元给爸爸买生日礼物", "cross", "birthday_lock", { amountCents: 50000 }, []],
  ["为女朋友的生日预留 2000 元", "cross", "birthday_lock", { amountCents: 200000 }, []],
  ["生日资金预锁 800 元", "cross", "birthday_lock", { amountCents: 80000 }, []],
  ["帮我在生日前锁定一笔钱", "cross", "birthday_lock", { amountCents: "*" }, []],
  ["订一个生日蛋糕", "cross", "birthday_book", { gift: "cake" }, []],
  ["预订鲜花送给妈妈", "cross", "birthday_book", { gift: "*" }, []],
  ["给女朋友订束花", "cross", "birthday_book", { gift: "*" }, []],
  ["生日蛋糕和鲜花都安排上", "cross", "birthday_book", { gift: "*" }, []],
  ["纪念日快到了，预订蛋糕", "cross", "birthday_book", { gift: "cake" }, []],
  // ---- 范围外 16 条（期望 unknown，不得误触发任何工具）----
  ["你好", "unknown", null, {}, []],
  ["今天天气怎么样", "unknown", null, {}, []],
  ["讲个笑话", "unknown", null, {}, []],
  ["查一下美元汇率", "unknown", null, {}, []],
  ["帮我写一首诗", "unknown", null, {}, []],
  ["现在几点了", "unknown", null, {}, []],
  ["附近有什么餐厅推荐", "unknown", null, {}, []],
  ["比特币现在什么价格", "unknown", null, {}, []],
  ["推荐一部电影", "unknown", null, {}, []],
  ["帮我翻译成英文", "unknown", null, {}, []],
  ["今天星期几", "unknown", null, {}, []],
  ["外面下雨了吗", "unknown", null, {}, []],
  ["你会做什么", "unknown", null, {}, []],
  ["美元汇率今天涨了吗", "unknown", null, {}, []],
  ["外汇牌价查一下", "unknown", null, {}, []],
  ["帮我汇总一下这篇报道", "unknown", null, {}, []],
];

let sceneOk = 0;
let slotTotal = 0;
let slotOk = 0;
const failures = [];
for (const [text, wantScene, wantTool, wantSlots, wantMissing] of CASES) {
  const intent = parseIntent(text, state);
  if (intent.scene === wantScene) sceneOk += 1;
  else failures.push({ text, kind: "scene", want: wantScene, got: intent.scene + "/" + intent.tool });
  if (wantTool !== null && intent.tool !== wantTool) {
    failures.push({ text, kind: "tool", want: wantTool, got: intent.tool });
  }
  const annotated = Object.keys(wantSlots).length > 0 || wantMissing.length > 0;
  if (!annotated) continue;
  slotTotal += 1;
  let ok = true;
  for (const [key, want] of Object.entries(wantSlots)) {
    const got = intent.slots[key];
    if (want === "*" ? got === undefined : String(got) !== String(want)) {
      ok = false;
      failures.push({ text, kind: "slot:" + key, want, got });
    }
  }
  for (const key of wantMissing) {
    if (!intent.missing.includes(key)) {
      ok = false;
      failures.push({ text, kind: "missing:" + key, want: "应缺失", got: intent.missing });
    }
  }
  if (ok) slotOk += 1;
}

const total = CASES.length;
const g2 = ((sceneOk / total) * 100).toFixed(1);
const g3 = slotTotal === 0 ? "n/a" : ((slotOk / slotTotal) * 100).toFixed(1);
console.log("G2 意图识别准确率: " + sceneOk + "/" + total + " = " + g2 + "%（目标 >=90%）");
console.log("G3 槽位填充完整率: " + slotOk + "/" + slotTotal + " = " + g3 + "%（目标 >=85%）");
if (failures.length > 0) {
  console.log("\n失败明细 " + failures.length + " 条:");
  for (const f of failures) {
    console.log("  [" + f.kind + "] " + f.text + "  期望=" + JSON.stringify(f.want) + "  实际=" + JSON.stringify(f.got));
  }
}
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
