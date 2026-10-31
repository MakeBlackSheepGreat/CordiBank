/**
 * 蜂群任务板：移植 DSH TeamTaskBoard 语义。
 * task-N 自增 id、revision CAS、四状态、八动作、DAG 四类校验、ready 派生、writeScope 冲突告警（advisory）。
 */

export type TeamTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TeamTaskAction =
  | "claim"
  | "release"
  | "edit"
  | "set_dependencies"
  | "complete"
  | "reopen"
  | "reassign"
  | "delete";

export interface TeamTask {
  id: string;
  revision: number;
  subject: string;
  description: string;
  status: TeamTaskStatus;
  /** 认领者成员名；pending/无主时为 undefined。 */
  owner?: string;
  blockedBy: string[];
  writeScopes: string[];
}

/** 面向消费方的任务视图：叠加 ready 派生与写域冲突告警。 */
export interface TeamTaskView extends Omit<TeamTask, "owner"> {
  ownerName?: string;
  ready: boolean;
  writeScopeWarnings: string[];
}

export interface TaskBoardLimits {
  maxTasks: number;
  /** writeScope 告警只对进行中任务比对，需知道成员当前在做的任务。 */
}

export interface TaskUpdateRequest {
  taskId: string;
  expectedRevision: number;
  action: TeamTaskAction;
  actor: string;
  subject?: string;
  description?: string;
  blockedBy?: string[];
  writeScopes?: string[];
  owner?: string;
}

/** 稳定错误码，与 DSH 命名一致便于对齐排障。 */
export class TeamError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const DEFAULT_MAX_TASKS = 256;

export class TaskBoard {
  private readonly tasks = new Map<string, TeamTask>();
  private nextId = 1;
  private readonly maxTasks: number;

  constructor(maxTasks: number = DEFAULT_MAX_TASKS) {
    this.maxTasks = maxTasks;
  }

  create(subject: string, description: string, blockedBy: string[] = [], writeScopes: string[] = []): TeamTaskView {
    const cleanSubject = subject.trim();
    if (cleanSubject === "") throw new TeamError("TEAM_TASK_INVALID_ARGUMENT", "任务标题不能为空");
    if (this.countLive() >= this.maxTasks) {
      throw new TeamError("TEAM_TASK_LIMIT", `任务数已达上限 ${this.maxTasks}`);
    }
    const id = `task-${this.nextId}`;
    this.nextId += 1;
    const task: TeamTask = {
      id,
      revision: 1,
      subject: cleanSubject,
      description: description.trim(),
      status: "pending",
      blockedBy: [...blockedBy],
      writeScopes: [...writeScopes],
    };
    this.tasks.set(id, task);
    return this.view(task);
  }

  get(taskId: string): TeamTaskView {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new TeamError("TEAM_TASK_NOT_FOUND", `任务 ${taskId} 不存在`);
    return this.view(task);
  }

  list(): TeamTaskView[] {
    return [...this.tasks.values()].map((task) => this.view(task));
  }

  update(request: TaskUpdateRequest): TeamTaskView {
    const task = this.tasks.get(request.taskId);
    if (task === undefined) throw new TeamError("TEAM_TASK_NOT_FOUND", `任务 ${request.taskId} 不存在`);
    if (task.revision !== request.expectedRevision) {
      throw new TeamError(
        "TEAM_TASK_STALE_REVISION",
        `任务 ${task.id} 修订号已前进（当前 ${task.revision}，请求基于 ${request.expectedRevision}），请重读后再改`,
      );
    }
    this.assertActor(task, request);
    switch (request.action) {
      case "claim": {
        if (task.status === "completed" || task.status === "deleted") {
          throw new TeamError("TEAM_TASK_INVALID_TRANSITION", `任务 ${task.id} 已 ${task.status}，不能认领`);
        }
        task.owner = request.actor;
        task.status = "in_progress";
        break;
      }
      case "release": {
        if (task.status !== "in_progress") {
          throw new TeamError("TEAM_TASK_INVALID_TRANSITION", `任务 ${task.id} 不在进行中，无法释放`);
        }
        task.owner = undefined;
        task.status = "pending";
        break;
      }
      case "edit": {
        if (request.subject !== undefined) {
          const subject = request.subject.trim();
          if (subject === "") throw new TeamError("TEAM_TASK_INVALID_ARGUMENT", "任务标题不能为空");
          task.subject = subject;
        }
        if (request.description !== undefined) task.description = request.description.trim();
        if (request.writeScopes !== undefined) task.writeScopes = [...request.writeScopes];
        break;
      }
      case "set_dependencies": {
        if (request.blockedBy === undefined) {
          throw new TeamError("TEAM_TASK_INVALID_ARGUMENT", "set_dependencies 需要 blockedBy 列表");
        }
        const next = [...request.blockedBy];
        this.assertTaskGraphCandidate(task.id, next);
        task.blockedBy = next;
        break;
      }
      case "complete": {
        if (task.status === "deleted") {
          throw new TeamError("TEAM_TASK_INVALID_TRANSITION", `任务 ${task.id} 已删除`);
        }
        if (task.status !== "in_progress" && task.status !== "pending") {
          throw new TeamError("TEAM_TASK_INVALID_TRANSITION", `任务 ${task.id} 已完成`);
        }
        task.status = "completed";
        break;
      }
      case "reopen": {
        if (task.status !== "completed" && task.status !== "deleted") {
          throw new TeamError("TEAM_TASK_INVALID_TRANSITION", `任务 ${task.id} 未完成或未删除，无需重开`);
        }
        task.status = "in_progress";
        task.owner = task.owner ?? request.actor;
        break;
      }
      case "reassign": {
        if (request.owner === undefined) {
          throw new TeamError("TEAM_TASK_INVALID_ARGUMENT", "reassign 需要 owner");
        }
        if (task.status === "deleted") {
          throw new TeamError("TEAM_TASK_INVALID_TRANSITION", `任务 ${task.id} 已删除`);
        }
        task.owner = request.owner;
        task.status = "in_progress";
        break;
      }
      case "delete": {
        const dependents = [...this.tasks.values()].filter(
          (item) => item.id !== task.id && item.status !== "deleted" && item.blockedBy.includes(task.id),
        );
        if (dependents.length > 0) {
          throw new TeamError("TEAM_TASK_HAS_DEPENDENTS", `任务 ${task.id} 被 ${dependents.map((item) => item.id).join(", ")} 依赖，不能删除`);
        }
        task.status = "deleted";
        task.owner = undefined;
        break;
      }
    }
    task.revision += 1;
    return this.view(task);
  }

  /** ready：全部阻塞项已完成（删除视为不存在阻塞）。 */
  private view(task: TeamTask): TeamTaskView {
    const live = [...this.tasks.values()].filter((item) => item.status !== "deleted");
    const byId = new Map(live.map((item) => [item.id, item]));
    const ready = task.blockedBy.every((blockedId) => byId.get(blockedId)?.status === "completed");
    const warnings: string[] = [];
    if (task.status === "in_progress") {
      for (const other of live) {
        if (other.id === task.id || other.status !== "in_progress") continue;
        for (const scope of task.writeScopes) {
          if (other.writeScopes.some((candidate) => scopesOverlap(scope, candidate))) {
            warnings.push(`写域 ${scope} 与 ${other.id}（${other.owner ?? "?"}）的写域重叠，仅提示不阻断`);
          }
        }
      }
    }
    return { ...task, ownerName: task.owner, ready, writeScopeWarnings: warnings };
  }

  private countLive(): number {
    return [...this.tasks.values()].filter((task) => task.status !== "deleted").length;
  }

  private assertActor(task: TeamTask, request: TaskUpdateRequest): void {
    if (request.actor === "lead") return;
    const needsOwner = request.action === "release" || request.action === "complete" || request.action === "edit";
    if (needsOwner && task.owner !== undefined && task.owner !== request.actor) {
      throw new TeamError("TEAM_TASK_UNAUTHORIZED", `任务 ${task.id} 由 ${task.owner} 认领，${request.actor} 无权${request.action}`);
    }
  }

  /** DAG 四类校验：自引用、重复、缺失、环。 */
  private assertTaskGraphCandidate(selfId: string, blockedBy: string[]): void {
    if (blockedBy.includes(selfId)) {
      throw new TeamError("TEAM_TASK_DEPENDENCY_CYCLE", `任务 ${selfId} 不能依赖自己`);
    }
    const seen = new Set<string>();
    for (const id of blockedBy) {
      if (seen.has(id)) throw new TeamError("TEAM_TASK_INVALID_ARGUMENT", `任务 ${selfId} 的阻塞项 ${id} 重复`);
      seen.add(id);
      if (!this.tasks.has(id) || this.tasks.get(id)!.status === "deleted") {
        throw new TeamError("TEAM_TASK_NOT_FOUND", `任务 ${selfId} 的阻塞项 ${id} 不存在或已删除`);
      }
    }
    // 环检测：DFS 染色，沿 blockedBy 边看能否走回 selfId。
    const visiting = new Set<string>();
    const walk = (current: string): boolean => {
      if (current === selfId) return true;
      if (visiting.has(current)) return false;
      visiting.add(current);
      const node = this.tasks.get(current);
      if (node === undefined) return false;
      return node.blockedBy.some((next) => walk(next));
    };
    for (const id of blockedBy) {
      if (walk(id)) {
        throw new TeamError("TEAM_TASK_DEPENDENCY_CYCLE", `设置阻塞项 ${id} 会使任务 ${selfId} 陷入依赖环`);
      }
    }
  }
}

/** writeScope 冲突判定：前缀包含（目录式覆盖）。 */
function scopesOverlap(a: string, b: string): boolean {
  const norm = (scope: string) => scope.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const left = norm(a);
  const right = norm(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
