/**
 * 蜂群花名册与编队运行时：移植 DSH TeamRoster/TeamService 语义。
 * lead 固定成员、teammate lower-kebab-case 校验、maxMembers 上限、成员信箱（入队即受理）、
 * runTurn 排空信箱驱动一轮模型运行；任务板与目标挂同一编队下。
 */

import { TaskBoard, TeamError, type TeamTaskAction, type TeamTaskView } from "./swarm-board.ts";
import { GoalManager, renderGoalRoundPrompt, type Goal, type GoalPhase } from "./swarm-goal.ts";

export type MemberStatus = "inactive" | "running" | "failed";

export interface TeamMember {
  name: string;
  role: string;
  description: string;
  status: MemberStatus;
  diagnostics: string[];
}

export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  at: string;
  delivered: boolean;
}

export interface MemberView extends TeamMember {
  inboxSize: number;
}

/** 一轮模型运行所需的输入与产出：由调用方注入真实 LLM 运行器。 */
export interface TurnInput {
  name: string;
  system: string;
  message: string;
}

export interface TurnOutcome {
  text: string;
  steps: number;
  stopReason: string;
}

export type TurnRunner = (input: TurnInput) => Promise<TurnOutcome>;

const MAX_MEMBERS = 16;
const MAX_MESSAGE_BYTES = 65536;
const MEMBER_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const INBOX_DELIVERY_LIMIT = 16;

interface MemberRecord {
  member: TeamMember;
  inbox: TeamMessage[];
  prompt?: string;
}

export interface SpawnRequest {
  name: string;
  role: string;
  description: string;
  /** 成员的系统提示词，供 runTurn 注入。 */
  prompt?: string;
}

export interface RosterLimits {
  maxMembers: number;
}

export class SwarmTeam {
  readonly board: TaskBoard;
  readonly goals: GoalManager;

  private readonly members = new Map<string, MemberRecord>();
  private readonly limits: RosterLimits;
  private messageSeq = 0;

  constructor(options: { maxMembers?: number; maxTasks?: number } = {}) {
    this.limits = { maxMembers: options.maxMembers ?? MAX_MEMBERS };
    this.board = new TaskBoard(options.maxTasks);
    this.goals = new GoalManager();
    this.members.set("lead", {
      member: {
        name: "lead",
        role: "arbiter",
        description: "蜂群主控：负责分派任务、仲裁结果、对齐目标",
        status: "inactive",
        diagnostics: [],
      },
      inbox: [],
    });
  }

  listMembers(): MemberView[] {
    return [...this.members.values()].map((record) => ({
      ...record.member,
      diagnostics: [...record.member.diagnostics],
      inboxSize: record.inbox.filter((message) => message.delivered === false).length,
    }));
  }

  member(name: string): MemberView {
    const record = this.members.get(name);
    if (record === undefined) throw new TeamError("TEAM_MEMBER_NOT_FOUND", `成员 ${name} 不存在`);
    return this.listMembers().find((item) => item.name === name)!;
  }

  spawn(request: SpawnRequest): MemberView {
    this.assertMemberName(request.name);
    if (this.members.has(request.name)) {
      throw new TeamError("TEAM_MEMBER_EXISTS", `成员 ${request.name} 已存在`);
    }
    if (this.members.size >= this.limits.maxMembers) {
      throw new TeamError("TEAM_MEMBER_LIMIT", `成员数已达上限 ${this.limits.maxMembers}`);
    }
    const description = request.description.trim();
    if (description === "" || description.length > 200) {
      throw new TeamError("TEAM_MEMBER_INVALID_ARGUMENT", "成员 description 必填且不超过 200 字");
    }
    const record: MemberRecord = {
      member: {
        name: request.name,
        role: request.role.trim() === "" ? "worker" : request.role.trim(),
        description,
        status: "inactive",
        diagnostics: [],
      },
      inbox: [],
      prompt: request.prompt,
    };
    this.members.set(request.name, record);
    return this.member(request.name);
  }

  /** 信箱投递：入队即受理（DSH 语义），是否被模型处理要看轮次运行。 */
  send(from: string, to: string, content: string): TeamMessage {
    if (this.members.has(from) === false) throw new TeamError("TEAM_MEMBER_NOT_FOUND", `发件人 ${from} 不存在`);
    const target = this.members.get(to);
    if (target === undefined) throw new TeamError("TEAM_MEMBER_NOT_FOUND", `收件人 ${to} 不存在`);
    if (Buffer.byteLength(content, "utf8") > MAX_MESSAGE_BYTES) {
      throw new TeamError("TEAM_MESSAGE_TOO_LARGE", `消息超过 ${MAX_MESSAGE_BYTES} 字节上限`);
    }
    if (content.trim() === "") {
      throw new TeamError("TEAM_MESSAGE_EMPTY", "消息内容不能为空");
    }
    this.messageSeq += 1;
    const message: TeamMessage = {
      id: `msg-${this.messageSeq}`,
      from,
      to,
      content,
      at: new Date().toISOString(),
      delivered: false,
    };
    target.inbox.push(message);
    return { ...message };
  }

  /** 中断成员：状态回到 inactive，信箱保留（DSH 语义）。 */
  interrupt(name: string): MemberView {
    const record = this.requireMember(name);
    record.member.status = "inactive";
    return this.member(name);
  }

  /** 驱动一轮：投递并排空信箱，调用注入的 runner。失败标记 failed 并保留未投递消息。 */
  async runTurn(name: string, runner: TurnRunner): Promise<{ member: MemberView; outcome?: TurnOutcome; inbox: TeamMessage[] }> {
    const record = this.requireMember(name);
    record.member.status = "running";
    record.member.diagnostics = [];
    const pending = record.inbox.filter((message) => message.delivered === false).slice(0, INBOX_DELIVERY_LIMIT);
    const deliveredMessages: TeamMessage[] = [];
    for (const message of pending) {
      message.delivered = true;
      deliveredMessages.push({ ...message });
    }
    const inboxText = deliveredMessages
      .map((message) => `[${message.id}] 来自 ${message.from}：${message.content}`)
      .join("\n");
    const system = record.prompt ?? `你是蜂群智能体 ${name}（角色 ${record.member.role}），职责：${record.member.description}。`;
    try {
      const outcome = await runner({
        name,
        system,
        message: inboxText === "" ? "（信箱为空，等待任务或按既有职责推进）" : inboxText,
      });
      record.member.status = "inactive";
      return { member: this.member(name), outcome, inbox: deliveredMessages };
    } catch (error) {
      record.member.status = "failed";
      record.member.diagnostics = [error instanceof Error ? error.message : String(error)];
      return { member: this.member(name), inbox: deliveredMessages };
    }
  }

  inbox(name: string): TeamMessage[] {
    const record = this.requireMember(name);
    return record.inbox.map((message) => ({ ...message }));
  }

  private requireMember(name: string): MemberRecord {
    const record = this.members.get(name);
    if (record === undefined) throw new TeamError("TEAM_MEMBER_NOT_FOUND", `成员 ${name} 不存在`);
    return record;
  }

  private assertMemberName(name: string): void {
    if (name === "lead") throw new TeamError("TEAM_MEMBER_INVALID_ARGUMENT", "成员名不能叫 lead");
    if (MEMBER_NAME_PATTERN.test(name) === false || name.length > 64) {
      throw new TeamError("TEAM_MEMBER_INVALID_ARGUMENT", `成员名须为 lower-kebab-case 且不超过 64 字符，收到 ${name}`);
    }
  }
}

/** 花名册转视图的工具别名，供插件层组装 RPC 返回。 */
export type { TeamTaskAction, TeamTaskView, Goal, GoalPhase };
export { renderGoalRoundPrompt };
