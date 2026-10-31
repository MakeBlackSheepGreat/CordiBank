// 意图理解评测（赛题 G2 意图识别准确率、G3 槽位填充完整率）：120 条中文指令跑规则层 parseIntent。
// 用法：node scripts/intent-eval.mjs [--out .intent-report.json]（不需要 API key）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../runtime/dist/config.js";
import { BankStore } from "../runtime/dist/bank/data.js";
import { parseIntent } from "../runtime/dist/bank/intent.js";
import { INTENT_CASES } from "./intent-cases.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outFile = outIndex >= 0 && args[outIndex + 1] !== undefined ? path.resolve(args[outIndex + 1]) : "";

const base = path.join(process.cwd(), ".intent-eval-tmp");
mkdirSync(base, { recursive: true });
const tmp = mkdtempSync(path.join(base, "run-"));
const cfg = loadConfig({ storeDir: path.join(tmp, "store"), skillsDir: path.join(tmp, "skills") });
mkdirSync(cfg.storeDir, { recursive: true });
const state = new BankStore(cfg.storeDir).load();

let sceneOk = 0;
let slotTotal = 0;
let slotOk = 0;
const failures = [];
for (const [text, wantScene, wantTool, wantSlots, wantMissing] of INTENT_CASES) {
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

const total = INTENT_CASES.length;
const g2 = Number((sceneOk / total).toFixed(4));
const g3 = slotTotal === 0 ? 0 : Number((slotOk / slotTotal).toFixed(4));
console.log("G2 意图识别准确率: " + sceneOk + "/" + total + " = " + (g2 * 100).toFixed(1) + "%（目标 >=90%）");
console.log("G3 槽位填充完整率: " + slotOk + "/" + slotTotal + " = " + (g3 * 100).toFixed(1) + "%（目标 >=85%）");
if (failures.length > 0) {
  console.log("\n失败明细 " + failures.length + " 条:");
  for (const f of failures) {
    console.log("  [" + f.kind + "] " + f.text + "  期望=" + JSON.stringify(f.want) + "  实际=" + JSON.stringify(f.got));
  }
}
if (outFile !== "") {
  writeFileSync(outFile, JSON.stringify({ g2, g3, sceneOk, slotTotal, slotOk, total, failures }, null, 2), "utf8");
}
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exitCode = g2 >= 0.9 && g3 >= 0.85 ? 0 : 1;
