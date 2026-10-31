import type { CapabilityPlugin } from "../capabilities/types.ts";
import type { RuntimeConfig } from "../config.ts";
import { RuntimeError } from "../core/errors.ts";

/** 长任务作业中心（对齐 dsh-jobs）：job id + 状态 + 输出分页拉取 + 协作式取消。 */

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  name: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  lines: string[];
  error?: string;
}

export interface JobView {
  id: string;
  name: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  outputBytes: number;
  error?: string;
}

export interface JobRunCtx {
  addLine: (text: string) => void;
  isCancelled: () => boolean;
}

type JobRunner = (ctx: JobRunCtx) => Promise<string>;

const MAX_JOBS = 64;
const MAX_LINES = 400;
const MAX_LINE_CHARS = 2000;
const PAGE_SIZE = 100;

export function createJobsPlugin(_cfg: RuntimeConfig): CapabilityPlugin {
  const jobs = new Map<string, JobRecord>();
  let seq = 0;

  const view = (job: JobRecord): JobView => ({
    id: job.id,
    name: job.name,
    status: job.status,
    createdAt: job.createdAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    outputBytes: job.lines.reduce((sum, line) => sum + line.length, 0),
    ...(job.error ? { error: job.error } : {}),
  });

  const evictOld = () => {
    if (jobs.size <= MAX_JOBS) return;
    for (const [id, job] of jobs) {
      if (jobs.size <= MAX_JOBS) break;
      if (job.status !== "running") jobs.delete(id);
    }
  };

  const provider = {
    /** 供进程内其他插件（如 scheduler）启动长任务；RPC 层不暴露。 */
    start(name: string, runner: JobRunner): string {
      seq += 1;
      const job: JobRecord = {
        id: `job-${seq}`,
        name,
        status: "running",
        createdAt: new Date().toISOString(),
        lines: [],
      };
      jobs.set(job.id, job);
      evictOld();
      const ctx: JobRunCtx = {
        addLine: (text) => {
          if (job.status !== "running") return;
          const line = text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) + "…（已截断）" : text;
          job.lines.push(line);
          if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
        },
        isCancelled: () => job.status === "cancelled",
      };
      void (async () => {
        try {
          const result = await runner(ctx);
          if (job.status !== "running") return;
          if (result) ctx.addLine(result);
          if (job.status !== "running") return;
          job.status = "completed";
          job.finishedAt = new Date().toISOString();
        } catch (error) {
          if (job.status !== "running") return;
          job.status = "failed";
          job.finishedAt = new Date().toISOString();
          job.error = error instanceof Error ? error.message : String(error);
        }
      })();
      return job.id;
    },
    list(): JobView[] {
      return [...jobs.values()].reverse().map(view);
    },
    output(jobId: string, offset = 0): { job: JobView; lines: string[]; nextOffset: number | null } {
      const job = jobs.get(jobId);
      if (!job) throw new RuntimeError("NOT_FOUND", `作业 "${jobId}" 不存在`);
      const start = Math.max(0, Math.floor(offset));
      const lines = job.lines.slice(start, start + PAGE_SIZE);
      const nextOffset = start + PAGE_SIZE < job.lines.length ? start + PAGE_SIZE : null;
      return { job: view(job), lines, nextOffset };
    },
    cancel(jobId: string): JobView {
      const job = jobs.get(jobId);
      if (!job) throw new RuntimeError("NOT_FOUND", `作业 "${jobId}" 不存在`);
      if (job.status === "running") {
        job.status = "cancelled";
        job.finishedAt = new Date().toISOString();
      }
      return view(job);
    },
  };

  return {
    name: "jobs",
    def: {
      service: "jobs.hub",
      methods: ["list", "output", "cancel"],
      description: "后台作业中心：长任务 job id、状态与输出分页拉取、协作式取消。",
    },
    provider: provider as unknown as CapabilityPlugin["provider"],
  };
}
