import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createJobsPlugin } from "../src/plugins/jobs.ts";
import { computeDue, createSchedulerPlugin, nextDailyOccurrence } from "../src/plugins/scheduler.ts";
import type { CapabilityPlugin } from "../src/capabilities/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(process.cwd(), ".test-tmp", "sched-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cfg() {
  return loadConfig({ storeDir: join(dir, "store"), skillsDir: join(dir, "skills") });
}

function fakeDeps(bank: CapabilityPlugin, jobs: CapabilityPlugin) {
  return { get: (id: string) => (id === "bank-agent" ? bank : id === "jobs" ? jobs : undefined) };
}

function fakeBank() {
  const calls: Array<{ sessionId: string; text: string }> = [];
  return {
    calls,
    plugin: {
      name: "bank-agent",
      def: { service: "bank.agent", methods: ["chat"] },
      provider: {
        chat: async (sessionId: string, text: string) => {
          calls.push({ sessionId, text });
          return { sessionId, reply: `伪回复：${text}` };
        },
      },
    } as unknown as CapabilityPlugin,
  };
}

describe("jobs hub", () => {
  it("start 完成后可分页拉取输出", async () => {
    const jobs = createJobsPlugin(cfg());
    const provider = jobs.provider as unknown as {
      start: (name: string, runner: (ctx: { addLine: (t: string) => void }) => Promise<string>) => string;
      list: () => unknown[];
      output: (id: string, offset?: number) => { job: { status: string }; lines: string[]; nextOffset: number | null };
    };
    const jobId = provider.start("报表", async (ctx) => {
      ctx.addLine("第一行");
      ctx.addLine("第二行");
      return "结论行";
    });
    await new Promise((r) => setTimeout(r, 20));
    const page = provider.output(jobId);
    expect(page.job.status).toBe("completed");
    expect(page.lines).toContain("第一行");
    expect(page.lines).toContain("结论行");
    expect(provider.list().length).toBe(1);
  });

  it("cancel 协作取消 running 作业", async () => {
    const jobs = createJobsPlugin(cfg());
    const provider = jobs.provider as unknown as {
      start: (name: string, runner: (ctx: { isCancelled: () => boolean }) => Promise<string>) => string;
      cancel: (id: string) => { status: string };
      output: (id: string) => { job: { status: string } };
    };
    let observedCancel = false;
    const jobId = provider.start("长任务", async (ctx) => {
      for (let i = 0; i < 50 && !ctx.isCancelled(); i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      observedCancel = ctx.isCancelled();
      return "未取消路径";
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(provider.cancel(jobId).status).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 100));
    expect(observedCancel).toBe(true);
    expect(provider.output(jobId).job.status).toBe("cancelled");
  });
});

describe("scheduler", () => {
  it("create 校验 kind/intervalMs/time", () => {
    const bank = fakeBank();
    const scheduler = createSchedulerPlugin(cfg(), fakeDeps(bank.plugin, createJobsPlugin(cfg())));
    const provider = scheduler.provider as unknown as Record<string, (...args: unknown[]) => unknown>;
    expect(() => provider.create({ name: "x", kind: "weekly", prompt: "hi" })).toThrow(/kind/);
    expect(() => provider.create({ name: "x", kind: "interval", intervalMs: 500, prompt: "hi" })).toThrow(/intervalMs/);
    expect(() => provider.create({ name: "x", kind: "daily", time: "25:00", prompt: "hi" })).toThrow(/HH:mm/);
  });

  it("手动 run 触发 bank-agent 会话并落作业与审计", async () => {
    const bank = fakeBank();
    const jobs = createJobsPlugin(cfg());
    const scheduler = createSchedulerPlugin(cfg(), fakeDeps(bank.plugin, jobs));
    const provider = scheduler.provider as unknown as {
      create: (input: Record<string, unknown>) => { id: string };
      run: (id: string) => Promise<{ jobId: string }>;
      list: () => Array<{ runCount: number; lastRunAt?: string }>;
    };
    const record = provider.create({ name: "日报", kind: "daily", time: "08:00", sessionId: "sched-1", prompt: "给我日报" });
    const { jobId } = await provider.run(record.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(bank.calls).toHaveLength(1);
    expect(bank.calls[0]?.sessionId).toBe("sched-1");
    const out = (jobs.provider as unknown as { output: (id: string) => { lines: string[] } }).output(jobId);
    expect(out.lines.join("\n")).toContain("伪回复：给我日报");
    const after = provider.list()[0];
    expect(after?.runCount).toBe(1);
    expect(after?.lastRunAt).toBeTruthy();
    expect(existsSync(join(dir, "store", "schedules.json"))).toBe(true);
    expect(existsSync(join(dir, "store", "schedules.audit.log"))).toBe(true);
  });

  it("computeDue：daily 到点补跑一次，interval 按 lastRunAt 推进", () => {
    const now = new Date("2026-01-10T09:30:00");
    const daily: Parameters<typeof computeDue>[0] = [{
      id: "d1", name: "日报", kind: "daily", time: "08:00", sessionId: "s", prompt: "p",
      enabled: true, createdAt: "2026-01-09T00:00:00", runCount: 0,
    }];
    expect(computeDue(daily, now)).toHaveLength(1);
    daily[0].lastRunAt = "2026-01-10T08:00:00";
    expect(computeDue(daily, now)).toHaveLength(0);
    const interval: Parameters<typeof computeDue>[0] = [{
      id: "i1", name: "巡检", kind: "interval", intervalMs: 60_000, sessionId: "s", prompt: "p",
      enabled: true, createdAt: "2026-01-10T09:00:00", runCount: 0,
    }];
    expect(computeDue(interval, new Date("2026-01-10T09:01:00"))).toHaveLength(1);
    expect(computeDue(interval, new Date("2026-01-10T09:00:30"))).toHaveLength(0);
    interval[0].enabled = false;
    expect(computeDue(interval, new Date("2026-01-10T09:30:00"))).toHaveLength(0);
  });

  it("tick 对到点任务执行且不重复触发", async () => {
    const bank = fakeBank();
    const scheduler = createSchedulerPlugin(cfg(), fakeDeps(bank.plugin, createJobsPlugin(cfg())));
    const provider = scheduler.provider as unknown as {
      create: (input: Record<string, unknown>) => { id: string };
      tick: () => Promise<string[]>;
    };
    provider.create({ name: "补跑", kind: "daily", time: "00:00", prompt: "早报" });
    const first = await provider.tick();
    expect(first).toHaveLength(1);
    const second = await provider.tick();
    expect(second).toHaveLength(0);
    expect(bank.calls).toHaveLength(1);
  });

  it("持久化：新实例从 schedules.json 恢复，mount 启动定时器 unmount 清理", () => {
    const bank = fakeBank();
    const first = createSchedulerPlugin(cfg(), fakeDeps(bank.plugin, createJobsPlugin(cfg())));
    const p1 = first.provider as unknown as { create: (input: Record<string, unknown>) => unknown; list: () => unknown[] };
    p1.create({ name: "持久", kind: "daily", time: "07:30", prompt: "p" });
    const second = createSchedulerPlugin(cfg(), fakeDeps(bank.plugin, createJobsPlugin(cfg())));
    second.mount?.();
    const p2 = second.provider as unknown as { list: () => unknown[] };
    expect(p2.list()).toHaveLength(1);
    second.unmount?.();
  });

  it("remove 与 setEnabled 生效", () => {
    const bank = fakeBank();
    const scheduler = createSchedulerPlugin(cfg(), fakeDeps(bank.plugin, createJobsPlugin(cfg())));
    const provider = scheduler.provider as unknown as {
      create: (input: Record<string, unknown>) => { id: string };
      list: () => Array<{ enabled: boolean }>;
      setEnabled: (id: string, on: boolean) => { enabled: boolean };
      remove: (id: string) => { removed: string };
    };
    const record = provider.create({ name: "临时", kind: "daily", time: "12:00", prompt: "p" });
    expect(provider.setEnabled(record.id, false).enabled).toBe(false);
    expect(provider.remove(record.id).removed).toBe(record.id);
    expect(provider.list()).toHaveLength(0);
  });

  it("nextDailyOccurrence 落在当天指定时刻", () => {
    const at = nextDailyOccurrence("08:30", new Date("2026-01-10T09:00:00"));
    expect(at.getHours()).toBe(8);
    expect(at.getMinutes()).toBe(30);
    expect(at.getDate()).toBe(10);
  });
});
