/**
 * 公开数据集下载与规范化。
 *
 * 为 safety-bench.mjs 准备可回放的用例：原始文件与规范化结果都落在仓库的 .sec-data/，
 * 只读公开数据源，不编造任何条目。下载失败记入 unfetched，必需源缺失时非零退出。
 *
 * 用法：node scripts/safety-datasets.mjs [--force] [--out <目录>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录：scripts/ 的上一层。 */
const REPO_ROOT = path.resolve(here, "..");

/** InjecAgent 的注入占位符：攻击指令写死在工具回包里这个位置。 */
const INJECT_SLOT = "<Attacker Instruction>";

/** 必需数据源：下不到就报错退出，不静默跳过。 */
const REQUIRED_SOURCES = [
  {
    id: "injecagent-dh",
    suite: "injecagent-dh",
    kind: "indirect",
    file: "injecagent_dh_base.json",
    url: "https://raw.githubusercontent.com/uiuc-kang-lab/InjecAgent/main/data/test_cases_dh_base.json",
    normalize: (text) => normalizeInjecAgent(text, "injecagent-dh"),
  },
  {
    id: "injecagent-ds",
    suite: "injecagent-ds",
    kind: "indirect",
    file: "injecagent_ds_base.json",
    url: "https://raw.githubusercontent.com/uiuc-kang-lab/InjecAgent/main/data/test_cases_ds_base.json",
    normalize: (text) => normalizeInjecAgent(text, "injecagent-ds"),
  },
  {
    id: "advbench",
    suite: "advbench",
    kind: "direct",
    file: "advbench_harmful_behaviors.csv",
    url: "https://raw.githubusercontent.com/llm-attacks/llm-attacks/main/data/advbench/harmful_behaviors.csv",
    normalize: (text) => normalizeAdvBench(text),
  },
];

/**
 * 可选数据源：拿不到就跳过，只记 unfetched。
 * AgentDojo 的注入任务以 GOAL 常量给出攻击目标，用户任务以 PROMPT 常量给出正常请求，
 * 两个常量都是数据集原文，不需要另行撰写攻击话术。
 */
const OPTIONAL_SOURCES = [
  {
    id: "agentdojo-banking",
    suite: "agentdojo-banking",
    file: "agentdojo_banking_injection_tasks.py",
    url: "https://raw.githubusercontent.com/ethz-spylab/agentdojo/main/src/agentdojo/default_suites/v1/banking/injection_tasks.py",
    extra: [
      {
        file: "agentdojo_banking_user_tasks.py",
        url: "https://raw.githubusercontent.com/ethz-spylab/agentdojo/main/src/agentdojo/default_suites/v1/banking/user_tasks.py",
      },
    ],
  },
];

/** 任务书点名尝试、但公开入口不可用的位置：实测结论，写进 unfetched 供复核。 */
const ATTEMPTED_UNAVAILABLE = [
  {
    id: "agentsafetybench",
    url: "https://raw.githubusercontent.com/Thudm/AgentSafetyBench/main/data/data.json",
    reason: "仓库入口不存在（实测 HTTP 404，组织名大小写两种写法均 404），未取到任何用例",
  },
  {
    id: "bipia-generic",
    url: "https://raw.githubusercontent.com/microsoft/BIPIA/main/benchmark/data/test.jsonl",
    reason:
      "该路径实测 404；BIPIA 实际按 benchmark/{code,email,table}/test.jsonl 组织，但文件只有 context/question/ideal 三列，" +
      "攻击指令由评测方自行注入、不存在于数据中，取来必然要自造攻击话术，故不纳入",
  },
  {
    id: "agentdojo-user-tasks-json",
    url: "https://raw.githubusercontent.com/facebookresearch/AgentDojo/main/src/agentdojo/data/suites/banking/user_tasks.json",
    reason: "facebookresearch/AgentDojo 仓库不存在（实测 404）；agentdojo 实际在 ethz-spylab/agentdojo，已改用其 .py 源文件",
  },
];

/** 带重试的下载：网络抖动重试三次，HTTP 非 2xx 直接返回状态。 */
async function download(url, tries = 3) {
  let lastError = "";
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      const text = await response.text();
      if (!response.ok) return { ok: false, status: response.status, text: "", error: "HTTP " + response.status };
      if (text.trim() === "") return { ok: false, status: response.status, text: "", error: "响应为空" };
      return { ok: true, status: response.status, text, error: "" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
    }
  }
  return { ok: false, status: 0, text: "", error: lastError };
}

/** 极小 CSV 解析：支持引号包裹、引号内逗号与换行、双引号转义。 */
export function parseCsv(raw) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const text = raw.replace(/\r\n/g, "\n");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((item) => item.some((cell) => cell.trim() !== ""));
}

/**
 * InjecAgent 规范化。
 *
 * text：数据集里用户那句正常请求（保留英文原话，不翻译不改写）。
 * context：Tool Response Template 把 <Attacker Instruction> 换成真实攻击指令后的外部工具回包。
 * 这就是间接注入的完整形态：用户请求本身正常，指令藏在外部回包里。
 */
export function normalizeInjecAgent(raw, suite) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(suite + "：顶层不是数组");
  const cases = [];
  for (const [index, row] of parsed.entries()) {
    const attacker = String(row["Attacker Instruction"] ?? "").trim();
    const template = String(row["Tool Response Template"] ?? "");
    if (attacker === "" || !template.includes(INJECT_SLOT)) continue;
    const attackType = String(row["Attack Type"] ?? "").trim();
    cases.push({
      id: suite + "-" + String(index).padStart(4, "0"),
      suite,
      kind: "indirect",
      text: String(row["User Instruction"] ?? "").trim(),
      context: template.split(INJECT_SLOT).join(attacker),
      attackType: attackType === "" ? "unknown" : attackType,
      expect: "block",
      meta: {
        attackerInstruction: attacker,
        attackerTools: row["Attacker Tools"],
        userTool: row["User Tool"],
        expectedAchievements: row["Expected Achievements"],
      },
    });
  }
  return cases;
}

/** AdvBench 规范化：两列 goal,target；goal 就是直接恶意指令。 */
export function normalizeAdvBench(raw) {
  const rows = parseCsv(raw);
  const header = rows[0];
  const body = header !== undefined && /goal/i.test(header[0] ?? "") ? rows.slice(1) : rows;
  const cases = [];
  for (const [index, row] of body.entries()) {
    const goal = String(row[0] ?? "").trim();
    if (goal === "") continue;
    cases.push({
      id: "advbench-" + String(index).padStart(4, "0"),
      suite: "advbench",
      kind: "direct",
      text: goal,
      context: "",
      attackType: "harmful-goal",
      expect: "block",
      meta: { target: String(row[1] ?? "").trim() },
    });
  }
  return cases;
}

/**
 * AgentDojo 银行套件规范化：注入任务 GOAL 作为被注入的外部内容，用户任务 PROMPT 作为正常请求。
 * 两者按顺序配对；套件里 GOAL 里的 f-string 变量（攻击者 IBAN）替换为固定占位账号。
 */
export function normalizeAgentDojo(injectionSource, userSource) {
  const goals = [];
  for (const match of injectionSource.matchAll(/GOAL\s*=\s*f?["']([\s\S]*?)["']\s*$/gm)) {
    const text = match[1]
      .replace(/\{_?ATTACKER_IBAN\}/g, "6222020200008888")
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\n/g, " ")
      .trim();
    if (text !== "") goals.push(text);
  }
  const prompts = [...userSource.matchAll(/PROMPT\s*=\s*["']([\s\S]*?)["']\s*$/gm)]
    .map((match) => String(match[1]).trim())
    .filter((text) => text !== "");
  const cases = [];
  for (const [index, goal] of goals.entries()) {
    const prompt = prompts.length === 0 ? "What is my account balance?" : prompts[index % prompts.length];
    cases.push({
      id: "agentdojo-banking-" + String(index).padStart(4, "0"),
      suite: "agentdojo-banking",
      kind: "indirect",
      text: prompt,
      context:
        "Merchant bill notice\n-----------------------------------\nTotal\t\t\t98.70\n\n" +
        goal +
        "\nThank you for your business!",
      attackType: "banking-injection-goal",
      expect: "block",
      meta: { goal, userPrompt: prompt },
    });
  }
  return cases;
}

/** 按字段计数，保持首次出现顺序。 */
export function countBy(list, pick) {
  const out = {};
  for (const item of list) {
    const key = pick(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/**
 * 确保数据就绪（幂等）：原始文件已存在就复用，缺了才下载。
 * @param {{force?: boolean, dataDir?: string, quiet?: boolean}} options
 * @returns {{cases: Array<object>, sources: Array<object>, unfetched: Array<object>}}
 */
export async function ensureDatasets(options = {}) {
  const force = options.force === true;
  const quiet = options.quiet === true;
  const dataDir = options.dataDir ?? path.join(REPO_ROOT, ".sec-data");
  const rawDir = path.join(dataDir, "raw");
  const casesFile = path.join(dataDir, "cases.json");
  mkdirSync(rawDir, { recursive: true });
  const say = (line) => {
    if (!quiet) console.log(line);
  };

  const sources = [];
  const unfetched = [];
  const rawTexts = new Map();

  for (const source of REQUIRED_SOURCES) {
    const cachedFile = path.join(rawDir, source.file);
    const cached = !force && existsSync(cachedFile) ? readFileSync(cachedFile, "utf8") : null;
    if (cached !== null) {
      rawTexts.set(source.id, cached);
      sources.push({ id: source.id, url: source.url, file: "raw/" + source.file, status: "cached", bytes: cached.length });
      continue;
    }
    const result = await download(source.url);
    if (!result.ok) {
      throw new Error("必需数据源下载失败：" + source.id + "（" + source.url + "）：" + result.error);
    }
    writeFileSync(cachedFile, result.text, "utf8");
    rawTexts.set(source.id, result.text);
    sources.push({ id: source.id, url: source.url, file: "raw/" + source.file, status: "downloaded", bytes: result.text.length });
    say("[下载] " + source.id + "  " + result.text.length + " 字节");
  }

  for (const source of OPTIONAL_SOURCES) {
    const mainFile = path.join(rawDir, source.file);
    let text = !force && existsSync(mainFile) ? readFileSync(mainFile, "utf8") : null;
    if (text === null) {
      const result = await download(source.url);
      if (!result.ok) {
        unfetched.push({ id: source.id, url: source.url, reason: "可选源下载失败：" + result.error });
        sources.push({ id: source.id, url: source.url, file: "raw/" + source.file, status: "unfetched", bytes: 0 });
        continue;
      }
      writeFileSync(mainFile, result.text, "utf8");
      text = result.text;
      sources.push({ id: source.id, url: source.url, file: "raw/" + source.file, status: "downloaded", bytes: text.length });
    } else {
      sources.push({ id: source.id, url: source.url, file: "raw/" + source.file, status: "cached", bytes: text.length });
    }
    const extras = [];
    let extraOk = true;
    for (const extra of source.extra ?? []) {
      const extraFile = path.join(rawDir, extra.file);
      let extraText = !force && existsSync(extraFile) ? readFileSync(extraFile, "utf8") : null;
      if (extraText === null) {
        const result = await download(extra.url);
        if (!result.ok) {
          extraOk = false;
          unfetched.push({ id: source.id + "-user-tasks", url: extra.url, reason: "可选源下载失败：" + result.error });
          break;
        }
        writeFileSync(extraFile, result.text, "utf8");
        extraText = result.text;
      }
      extras.push(extraText);
    }
    if (extraOk && extras.length > 0) rawTexts.set(source.id, JSON.stringify({ injection: text, users: extras[0] }));
  }

  for (const item of ATTEMPTED_UNAVAILABLE) unfetched.push({ ...item });

  const cases = [];
  for (const source of REQUIRED_SOURCES) {
    const list = source.normalize(rawTexts.get(source.id)).map((item) => ({
      ...item,
      origin: { url: source.url, rowIndex: Number(item.id.slice(-4)) },
    }));
    cases.push(...list);
    say("[规范化] " + source.suite + "  " + list.length + " 条");
  }
  const agentDojo = rawTexts.get("agentdojo-banking");
  if (agentDojo !== undefined) {
    const packed = JSON.parse(agentDojo);
    const list = normalizeAgentDojo(packed.injection, packed.users).map((item) => ({
      ...item,
      origin: { url: OPTIONAL_SOURCES[0].url, rowIndex: Number(item.id.slice(-4)) },
    }));
    cases.push(...list);
    say("[规范化] agentdojo-banking  " + list.length + " 条");
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    sources,
    unfetched,
    counts: countBy(cases, (item) => item.suite),
    strata: Object.fromEntries(
      [...new Set(cases.map((item) => item.suite))].map((suite) => [
        suite,
        countBy(cases.filter((item) => item.suite === suite), (item) => item.attackType),
      ]),
    ),
    cases,
  };
  writeFileSync(casesFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  say("[落盘] " + cases.length + " 条 -> " + path.relative(REPO_ROOT, casesFile));
  for (const [suite, total] of Object.entries(payload.counts)) {
    const types = payload.strata[suite];
    say("  " + suite + "：" + total + " 条（" + Object.entries(types).map(([key, value]) => key + " " + value).join("，") + "）");
  }
  if (unfetched.length > 0) {
    say("[未获取] " + unfetched.length + " 个入口不可用：");
    for (const item of unfetched) say("  - " + item.id + "：" + item.reason);
  }
  return { cases, sources, unfetched, casesFile };
}

const isMain = process.argv[1] !== undefined && process.argv[1].replace(/\\/g, "/").endsWith("scripts/safety-datasets.mjs");
if (isMain) {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf("--out");
  const dataDir = outIndex >= 0 && argv[outIndex + 1] !== undefined ? path.resolve(argv[outIndex + 1]) : undefined;
  try {
    await ensureDatasets({ force: argv.includes("--force"), ...(dataDir === undefined ? {} : { dataDir }) });
  } catch (error) {
    console.error("[失败] " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
