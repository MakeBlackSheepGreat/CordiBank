/**
 * 蜂群目标管理：移植 DSH GoalService + goal-round-driver 语义。
 * 单活跃目标、revision CAS、phase active/paused/blocked/complete、轮次计数与 goal_round 提示词渲染。
 */

import { TeamError } from "./swarm-board.ts";

export type GoalPhase = "active" | "paused" | "blocked" | "complete";

export interface BlockedReason {
  code: string;
  message: string;
}

export interface GoalRoundRecord {
  round: number;
  summary: string;
  at: string;
}

export interface Goal {
  revision: number;
  objective: string;
  maxGoalRounds: number;
  roundsStarted: number;
  phase: GoalPhase;
  blockedReason?: BlockedReason;
  progress: GoalRoundRecord[];
}

const DEFAULT_MAX_GOAL_ROUNDS = 256;
const GOAL_CODE_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** 每轮进度记录保留的摘要长度上限。 */
const ROUND_SUMMARY_LIMIT = 400;

export class GoalManager {
  private goal: Goal | undefined;

  create(objective: string, maxGoalRounds: number = DEFAULT_MAX_GOAL_ROUNDS): Goal {
    if (this.goal !== undefined && this.goal.phase === "active") {
      throw new TeamError("TEAM_GOAL_ALREADY_ACTIVE", "已有进行中的目标，先 pause/complete 再创建");
    }
    this.goal = {
      revision: 1,
      objective: this.assertObjective(objective),
      maxGoalRounds: this.assertRounds(maxGoalRounds),
      roundsStarted: 0,
      phase: "active",
      progress: [],
    };
    return { ...this.goal };
  }

  get(): Goal | undefined {
    return this.goal === undefined ? undefined : { ...this.goal };
  }

  /** 每轮开始前调用：校验可续轮并计数。 */
  beginRound(): { objective: string; round: number; maxGoalRounds: number } {
    const goal = this.require();
    if (goal.phase !== "active") {
      throw new TeamError("TEAM_GOAL_NOT_ACTIVE", `目标处于 ${goal.phase}，不能续轮`);
    }
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      throw new TeamError("TEAM_GOAL_ROUNDS_EXHAUSTED", `目标轮次已达上限 ${goal.maxGoalRounds}`);
    }
    goal.roundsStarted += 1;
    goal.revision += 1;
    return { objective: goal.objective, round: goal.roundsStarted, maxGoalRounds: goal.maxGoalRounds };
  }

  /** 每轮结束后记录进展摘要。 */
  recordRound(round: number, summary: string): Goal {
    const goal = this.require();
    goal.progress.push({
      round,
      summary: summary.trim().slice(0, ROUND_SUMMARY_LIMIT),
      at: new Date().toISOString(),
    });
    return { ...goal };
  }

  edit(patch: { objective?: string; maxGoalRounds?: number }): Goal {
    const goal = this.require();
    if (patch.objective !== undefined) goal.objective = this.assertObjective(patch.objective);
    if (patch.maxGoalRounds !== undefined) {
      if (patch.maxGoalRounds < goal.roundsStarted) {
        throw new TeamError("TEAM_GOAL_INVALID_ROUNDS", `maxGoalRounds 不能小于已开轮数 ${goal.roundsStarted}`);
      }
      goal.maxGoalRounds = this.assertRounds(patch.maxGoalRounds);
    }
    goal.revision += 1;
    return { ...goal };
  }

  pause(): Goal {
    const goal = this.require();
    if (goal.phase !== "active") throw new TeamError("TEAM_GOAL_INVALID_TRANSITION", `目标处于 ${goal.phase}，不能暂停`);
    goal.phase = "paused";
    goal.revision += 1;
    return { ...goal };
  }

  resume(): Goal {
    const goal = this.require();
    if (goal.phase !== "paused" && goal.phase !== "blocked") throw new TeamError("TEAM_GOAL_INVALID_TRANSITION", `目标处于 ${goal.phase}，不能恢复`);
    goal.phase = "active";
    goal.blockedReason = undefined;
    goal.revision += 1;
    return { ...goal };
  }

  blocked(reason: BlockedReason): Goal {
    const goal = this.require();
    if (goal.phase !== "active") throw new TeamError("TEAM_GOAL_INVALID_TRANSITION", `目标处于 ${goal.phase}，不能标记受阻`);
    if (GOAL_CODE_PATTERN.test(reason.code) === false) {
      throw new TeamError("TEAM_GOAL_INVALID_REASON", `blocked code 须形如 kebab-case，收到 ${reason.code}`);
    }
    if (reason.message.trim() === "") {
      throw new TeamError("TEAM_GOAL_INVALID_REASON", "blocked message 不能为空");
    }
    goal.phase = "blocked";
    goal.blockedReason = { code: reason.code, message: reason.message.trim() };
    goal.revision += 1;
    return { ...goal };
  }

  complete(): Goal {
    const goal = this.require();
    if (goal.phase === "complete") throw new TeamError("TEAM_GOAL_INVALID_TRANSITION", "目标已完成");
    goal.phase = "complete";
    goal.blockedReason = undefined;
    goal.revision += 1;
    return { ...goal };
  }

  private require(): Goal {
    if (this.goal === undefined) throw new TeamError("TEAM_GOAL_NOT_FOUND", "尚未创建目标");
    return this.goal;
  }

  private assertObjective(objective: string): string {
    const trimmed = objective.trim();
    if (trimmed === "") throw new TeamError("TEAM_GOAL_INVALID_ARGUMENT", "目标 objective 不能为空");
    return trimmed;
  }

  private assertRounds(maxGoalRounds: number): number {
    if (Number.isInteger(maxGoalRounds) === false || maxGoalRounds < 1) {
      throw new TeamError("TEAM_GOAL_INVALID_ROUNDS", "maxGoalRounds 须为正整数");
    }
    return maxGoalRounds;
  }
}

/** 渲染一轮目标续跑提示词（DSH goal_round 的中文同构）。 */
export function renderGoalRoundPrompt(goal: { objective: string; round: number; maxGoalRounds: number }, progress: GoalRoundRecord[]): string {
  const lines = [
    "<goal_round>",
    `目标：${JSON.stringify(goal.objective)}`,
    `轮次：${goal.round}/${goal.maxGoalRounds}`,
    "在本次运行中继续朝目标推进。以当前工作区、工具结果与持久化状态为准。",
  ];
  if (progress.length > 0) {
    lines.push("此前轮次进展：");
    for (const record of progress.slice(-5)) {
      lines.push(`- 第 ${record.round} 轮：${record.summary || "（无摘要）"}`);
    }
  }
  lines.push("只有在拿到真实证据后才能宣布目标完成；遇到持续阻塞请明确给出 blocked 原因而不是空转。");
  lines.push("</goal_round>");
  return lines.join("\n");
}
