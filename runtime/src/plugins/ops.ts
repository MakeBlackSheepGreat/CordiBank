import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDescriptor } from "../harness/types.ts";
import type { RuntimeConfig } from "../config.ts";

/** OPS 沙箱执行层：对齐 DSH dsh-ptc-runtime + dsh-bash-sandbox + dsh-spill。 */
export const OPS_RUN_TOOL = "ops_run";

const OPS_TIMEOUT_DEFAULT_MS = 30_000;
const OPS_TIMEOUT_MAX_MS = 120_000;
const OPS_SUMMARY_LIMIT = 2000;

/** 白名单解释器：只放行数据分析类命令，首词不含路径分隔符。 */
const OPS_ALLOWLIST = new Set(["node", "python", "python3", "py"]);

/** shell 元字符拒绝：spawn 直启不经 shell，杜绝拼接注入面。 */
const SHELL_META = /[&|;`$<>()\r\n]/;

/** 子进程最小环境：不带业务密钥，防模型输出泄漏凭据。 */
const OPS_ENV_KEYS = [
  "PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT",
  "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS", "OS", "PROCESSOR_ARCHITECTURE",
];

function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of OPS_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** OPS 工具描述符：CORDIBANK_OPS=off 时不下发。 */
export function opsToolDescriptors(cfg: RuntimeConfig): ToolDescriptor[] {
  if (!cfg.opsEnabled) return [];
  return [
    {
      name: OPS_RUN_TOOL,
      summary:
        "在隔离沙箱目录运行数据分析脚本（node/python 白名单），带超时、最小环境与输出落盘，用于账单统计、报表计算等只读分析",
      source: "builtin",
      scene: "cross",
      risk: { level: "green", reversible: true, write: false },
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "命令首词必须是 node/python/python3/py（不带路径），其余词为命令行参数" },
          args: { type: "array", items: { type: "string" }, description: "参数列表，含空格或引号的脚本内容建议放这里" },
          timeoutMs: { type: "number", description: "超时毫秒，默认 30000，上限 120000" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ];
}

export interface OpsRunResult {
  ok: boolean;
  summary: string;
}

interface OpsParams {
  command?: unknown;
  args?: unknown;
  timeoutMs?: unknown;
}

/** OPS 执行器：白名单 + 元字符拒绝 + 沙箱目录 + 最小环境 + 超时 + spill + 追加审计。 */
export function createOpsExtras(cfg: RuntimeConfig): Record<string, (args: unknown) => Promise<OpsRunResult>> {
  return {
    [OPS_RUN_TOOL]: (raw) => runOpsCommand(cfg, raw),
  };
}

async function runOpsCommand(cfg: RuntimeConfig, raw: unknown): Promise<OpsRunResult> {
  const params = (raw ?? {}) as OpsParams;
  const command = typeof params.command === "string" ? params.command.trim() : "";
  if (command === "") return { ok: false, summary: "命令不能为空" };
  if (SHELL_META.test(command)) return { ok: false, summary: "命令含 shell 元字符，已拒绝" };
  const tokens = command.split(/\s+/);
  const head = tokens[0] ?? "";
  if (/[\\/]/.test(head) || head.includes(":")) return { ok: false, summary: "命令必须是白名单解释器名，不能带路径" };
  const base = head.toLowerCase().replace(/\.exe$/, "");
  if (!OPS_ALLOWLIST.has(base)) {
    return { ok: false, summary: "命令不在白名单（node/python/python3/py）：" + head };
  }
  const extraArgs = Array.isArray(params.args) ? params.args.map(String) : [];
  const rawTimeout = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) ? params.timeoutMs : OPS_TIMEOUT_DEFAULT_MS;
  const timeoutMs = Math.min(Math.max(Math.trunc(rawTimeout), 1000), OPS_TIMEOUT_MAX_MS);

  mkdirSync(cfg.opsDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const child = spawn(head, [...tokens.slice(1), ...extraArgs], {
    cwd: cfg.opsDir,
    env: sanitizedEnv(),
    windowsHide: true,
  });

  let captured = "";
  const capture = (chunk: Buffer | string) => {
    if (captured.length < OPS_SUMMARY_LIMIT * 4) captured += chunk.toString("utf8");
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  let exitCode: number | null = null;
  let timedOut = false;
  const done = new Promise<void>((resolve) => {
    child.on("close", (code) => {
      exitCode = code;
      resolve();
    });
    child.on("error", () => {
      exitCode = -1;
      resolve();
    });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  await done;
  clearTimeout(timer);

  const output = captured.trim();
  let spillPath: string | null = null;
  if (output.length > OPS_SUMMARY_LIMIT) {
    const spillDir = join(cfg.opsDir, "spill");
    mkdirSync(spillDir, { recursive: true });
    spillPath = join(spillDir, Date.now() + "-run.txt");
    writeFileSync(spillPath, output, "utf8");
  }

  const record = {
    ts: startedAt,
    command: head,
    args: extraArgs,
    exitCode,
    timedOut,
    spill: spillPath,
    outputBytes: output.length,
  };
  appendFileSync(join(cfg.opsDir, "audit.log"), JSON.stringify(record) + "\n", "utf8");

  if (timedOut) {
    const partial = output === "" ? "" : "；部分输出：" + output.slice(0, 500);
    return { ok: false, summary: "执行超时（" + timeoutMs + "ms），已终止" + partial };
  }
  if (exitCode === -1) return { ok: false, summary: "命令启动失败，请确认白名单解释器可用" };
  if (spillPath !== null) {
    return { ok: true, summary: output.slice(0, OPS_SUMMARY_LIMIT) + "…（已截断，完整输出落盘 " + spillPath + "）" };
  }
  return { ok: true, summary: output === "" ? "命令执行完成，无输出" : output };
}
