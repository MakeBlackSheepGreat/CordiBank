// 校验 README 与安全自评报告里的指标表是否与评测报告一致
// 用法：先跑 npm run eval 生成 .eval-report.json，再 node scripts/verify-tables.mjs
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const reportPath = path.join(root, ".eval-report.json");
if (!fs.existsSync(reportPath)) {
  console.error("缺少 .eval-report.json，请先运行 npm run eval");
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const rows = new Map([...report.spec, ...report.extra].map((item) => [item.id, item]));

const targets = [
  { file: "README.md", start: "### 赛题指标口径", end: "## 快速开始", ids: [...rows.keys()] },
  { file: "docs/03-安全自评报告.md", start: "### 赛题指标实测", end: "## 三、已知风险清单", ids: report.spec.map((item) => item.id) },
];

let bad = 0;
for (const target of targets) {
  const text = fs.readFileSync(path.join(root, target.file), "utf8");
  const section = text.split(target.start)[1];
  if (section === undefined) {
    console.error(`${target.file} 缺少小节 ${target.start}`);
    bad += 1;
    continue;
  }
  const body = section.split(target.end)[0];
  for (const id of target.ids) {
    const row = rows.get(id);
    const line = body.split("\n").find((item) => item.startsWith(`| ${id} |`));
    if (line === undefined) {
      console.error(`${target.file} 缺少 ${id} 行`);
      bad += 1;
      continue;
    }
    const cells = line.split("|").map((item) => item.trim());
    const expect = [row.name, row.display, row.target, row.pass ? "达标" : "未达标"];
    const actual = cells.slice(2, 6);
    if (expect.join(" / ") !== actual.join(" / ")) {
      console.error(`${target.file} ${id} 不一致：文档 ${actual.join(" / ")}，报告 ${expect.join(" / ")}`);
      bad += 1;
    }
  }
}

if (bad > 0) {
  console.error(`指标表校验失败：${bad} 处不一致`);
  process.exit(1);
}
console.log(`指标表校验通过：${targets.length} 份文档，${rows.size} 项指标`);
