import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CapabilityPlugin } from "../capabilities/types.ts";
import type { RuntimeConfig } from "../config.ts";
import { RuntimeError } from "../core/errors.ts";

/** 定时任务（对齐 dsh-schedule）：持久化 interval/daily 任务，到点跑绑定会话的银行 Agent 提示，产出进 jobs 作业中心。 */

export interface ScheduleRecord {
  id: string;
  name: string;
  kind: "interval" | "daily";
  intervalMs?: number;
  time?: string;
  sessionId: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  runCount: number;
}

export interface PluginDepsView {
  get: (id: string) => CapabilityPlugin | undefined;
}

const MIN_INTERVAL_MS = 60_000;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const TICK_MS = 15_000;
const REPLY_LIMIT = 1500;

export function nextDailyOccurrence(time: string, from: Date): Date {
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const at = new Date(from);
  at.setHours(hh ?? 0, mm ?? 0, 0, 0);
  return at;
}

/** 纯函数：算出此刻已到点、需要执行的任务（interval 按 lastRunAt+interval，daily 按当日 HH:mm）。 */
export function computeDue(records: ScheduleRecord[], now: Date): ScheduleRecord[] {
  return records.filter((record) => {
    if (!record.enabled) return false;
    if (record.kind === "interval") {
      const base = record.lastRunAt ?? record.createdAt;
      return new Date(base).getTime() + (record.intervalMs ?? 0) <= now.getTime();
    }
    const scheduled = nextDailyOccurrence(record.time ?? "00:00", now);
    if (now < scheduled) return false;
    return !record.lastRunAt || new Date(record.lastRunAt) < scheduled;
  });
}

export function createSchedulerPlugin(cfg: RuntimeConfig, deps: PluginDepsView): CapabilityPlugin {
  const file = path.join(cfg.storeDir, "schedules.json");
  const auditFile = path.join(cfg.storeDir, "schedules.audit.log");
  let records: ScheduleRecord[] = [];
  let seq = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const bankProvider = () => deps.get("bank-agent")?.provider;
  const jobsProvider = () => deps.get("jobs")?.provider;

  const persist = () => {
    mkdirSync(cfg.storeDir, { recursive: true });
    writeFileSync(file, JSON.stringify(records, null, 2), "utf8");
  };

  const audit = (entry: Record<string, unknown>) => {
    mkdirSync(cfg.storeDir, { recursive: true });
    appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  };

  const load = () => {
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(raw)) records = raw as ScheduleRecord[];
    } catch {
      records = [];
    }
  };

  const requireRecord = (id: string): ScheduleRecord => {
    const record = records.find((item) => item.id === id);
    if (!record) throw new RuntimeError("NOT_FOUND", `定时任务 "${id}" 不存在`);
    return record;
  };

  const execute = async (record: ScheduleRecord, trigger: string): Promise<string> => {
    const jobs = jobsProvider();
    const bank = bankProvider();
    if (!jobs || !bank) throw new RuntimeError("RESOURCE_UNAVAILABLE", "scheduler 需要 jobs 与 bank-agent 插件同时挂载");
    const jobId = (jobs as { start: (name: string, runner: unknown) => string }).start(
      record.name,
      async (ctx: { addLine: (text: string) => void; isCancelled: () => boolean }) => {
        ctx.addLine(`触发方式：${trigger}；提示：${record.prompt}`);
        const reply = (await (bank as { chat: (sessionId: string, text: string) => Promise<unknown> }).chat(
          record.sessionId,
          record.prompt,
        )) as { reply?: unknown; loop?: { text?: unknown } };
        const text = String(reply?.loop?.text ?? reply?.reply ?? "");
        ctx.addLine(text.slice(0, REPLY_LIMIT) || "（模型未返回正文）");
        return text.slice(0, REPLY_LIMIT);
      },
    );
    record.lastRunAt = new Date().toISOString();
    record.runCount += 1;
    persist();
    audit({ action: "run", taskId: record.id, trigger, jobId });
    return jobId;
  };

  const tick = async (): Promise<string[]> => {
    const due = computeDue(records, new Date());
    const jobIds: string[] = [];
    for (const record of due) {
      try {
        jobIds.push(await execute(record, "定时到点"));
      } catch (error) {
        audit({ action: "run-failed", taskId: record.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return jobIds;
  };

  const provider = {
    create(input: {
      name: unknown;
      kind: unknown;
      intervalMs?: unknown;
      time?: unknown;
      sessionId?: unknown;
      prompt: unknown;
    }): ScheduleRecord {
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (name.length === 0 || name.length > 60) throw new RuntimeError("INVALID_INPUT", "name 必须是 1-60 字符");
      const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
      if (prompt.length === 0 || prompt.length > 2000) throw new RuntimeError("INVALID_INPUT", "prompt 必须是 1-2000 字符");
      const kind = input?.kind;
      if (kind !== "interval" && kind !== "daily") throw new RuntimeError("INVALID_INPUT", "kind 必须是 interval 或 daily");
      const record: ScheduleRecord = {
        id: `sched-${++seq}`,
        name,
        kind,
        sessionId: typeof input?.sessionId === "string" && input.sessionId.trim() !== "" ? input.sessionId.trim() : "schedule",
        prompt,
        enabled: true,
        createdAt: new Date().toISOString(),
        runCount: 0,
      };
      if (kind === "interval") {
        const intervalMs = input?.intervalMs;
        if (typeof intervalMs !== "number" || !Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
          throw new RuntimeError("INVALID_INPUT", `intervalMs 必须是不小于 ${MIN_INTERVAL_MS} 的整数`);
        }
        record.intervalMs = intervalMs;
      } else {
        const time = input?.time;
        if (typeof time !== "string" || !TIME_PATTERN.test(time)) throw new RuntimeError("INVALID_INPUT", "time 必须是 HH:mm（24 小时制）");
        record.time = time;
      }
      records.push(record);
      persist();
      audit({ action: "create", taskId: record.id, kind: record.kind, name: record.name });
      return record;
    },
    list(): ScheduleRecord[] {
      return records.map((record) => ({ ...record }));
    },
    remove(id: string): { removed: string } {
      const record = requireRecord(id);
      records = records.filter((item) => item.id !== id);
      persist();
      audit({ action: "remove", taskId: record.id });
      return { removed: id };
    },
    setEnabled(id: string, enabled: unknown): ScheduleRecord {
      if (typeof enabled !== "boolean") throw new RuntimeError("INVALID_INPUT", "enabled 必须是布尔值");
      const record = requireRecord(id);
      record.enabled = enabled;
      persist();
      audit({ action: enabled ? "resume" : "pause", taskId: id });
      return { ...record };
    },
    async run(id: string): Promise<{ jobId: string }> {
      const record = requireRecord(id);
      const jobId = await execute(record, "手动触发");
      return { jobId };
    },
    async tick(): Promise<string[]> {
      return tick();
    },
  };

  return {
    name: "scheduler",
    def: {
      service: "scheduler.hub",
      methods: ["create", "list", "remove", "setEnabled", "run"],
      description: "定时任务：持久化 interval/daily 计划，到点驱动银行 Agent 提示并落作业中心。",
    },
    provider: provider as unknown as CapabilityPlugin["provider"],
    mount() {
      load();
      seq = records.length;
      timer = setInterval(() => void tick(), TICK_MS);
      if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as { unref: () => void }).unref();
    },
    unmount() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
