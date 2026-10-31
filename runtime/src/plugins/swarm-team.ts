/**
 * 蜂群编队能力：把 DSH Agent Teams 的花名册/信箱/任务板与 Goal 的目标管理
 * 移植为 swarm.team.* 服务。队友只挂只读工具（写域隔离），lead 续轮输出
 * 经关键词防控与评估模型双重守卫后再对外。
 */

import type { RuntimeConfig } from "../config.ts";
import type { CapabilityPlugin } from "../capabilities/types.ts";
import { BankStore } from "../bank/data.ts";
import { builtinToolDescriptors } from "../bank/builtin-tools.ts";
import { ModelBrain } from "../bank/model-brain.ts";
import { OutputReviewer, type ReviewVerdict } from "../bank/reviewer.ts";
import {
  SwarmTeam,
  type MemberView,
  type TeamMessage,
  type TurnOutcome,
} from "../bank/swarm-roster.ts";
import type { TeamTaskView } from "../bank/swarm-board.ts";
import { renderGoalRoundPrompt, type Goal } from "../bank/swarm-goal.ts";
import { ToolRegistry } from "../harness/registry.ts";
import { LlmClient } from "../llm/client.ts";
import type { Effort } from "../llm/types.ts";

/** 队友默认思考强度：常规推理即可，成本与延迟优先。 */
const TEAM_EFFORT: Effort = "low";

/** 队伍规模：与 DSH 一致的缺省上限。 */
const MAX_MEMBERS = 16;

/** 评估模型拦截后的替换文案：直接截断外部输出并给出危险提醒。 */
function dangerReplacement(reason: string): string {
  return `[已拦截] 输出内容触发安全审查（${reason}），已整段截断。如有正常业务需求，请换个说法重试。`;
}

/** 蜂群编队能力：暴露 swarm.team.* 服务。 */
export function createSwarmTeamPlugin(cfg: RuntimeConfig): CapabilityPlugin {
  const team = new SwarmTeam({ maxMembers: MAX_MEMBERS });
  let brain: ModelBrain | null = null;
  let reviewer: OutputReviewer | null = null;

  /** 懒加载模型大脑：独立于 bank-agent 的实例，只读工具、写域隔离。 */
  const engine = (): ModelBrain | null => {
    if (brain !== null) return brain;
    if (cfg.llm.apiKey === "") return null;
    const registry = new ToolRegistry();
    registry.registerMany(builtinToolDescriptors());
    const store = new BankStore(cfg.storeDir);
    brain = new ModelBrain(
      new LlmClient(cfg.llm),
      () => store.load(),
      registry,
      undefined,
      undefined,
      cfg.guardKeywords,
    );
    return brain;
  };

  const ensureReviewer = (): OutputReviewer | null => {
    if (cfg.reviewerEnabled === false) return null;
    if (reviewer === null) reviewer = OutputReviewer.fromSettings(cfg.llm) ?? null;
    return reviewer;
  };

  /** 一轮模型运行器：成员提示词覆盖默认系统提示。 */
  const runner = async (input: { name: string; system: string; message: string }): Promise<TurnOutcome> => {
    const model = engine();
    if (model === null) {
      throw new Error("模型未配置，蜂群成员无法运行");
    }
    const outcome = await model.converse(input.message, {
      systemPrompt: input.system,
      effort: TEAM_EFFORT,
    });
    return { text: outcome.text, steps: outcome.steps.length, stopReason: outcome.stopReason };
  };

  /** 审查一轮输出：评估模型不通过即整段替换为危险提醒。 */
  const guardTurn = async (text: string): Promise<{ text: string; review: ReviewVerdict }> => {
    const checker = ensureReviewer();
    if (checker === null || text.trim() === "") return { text, review: { ok: true, reason: "" } };
    const verdict = await checker.review(text);
    return verdict.ok ? { text, review: verdict } : { text: dangerReplacement(verdict.reason), review: verdict };
  };

  const asString = (value: unknown, name: string): string => {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`swarm.team 需要非空字符串参数：${name}`);
    return value;
  };

  const asNumber = (value: unknown, name: string): number => {
    if (typeof value !== "number" || Number.isInteger(value) === false) {
      throw new Error(`swarm.team 需要整数参数：${name}`);
    }
    return value;
  };

  return {
    name: "swarm-team",
    def: {
      service: "swarm.team",
      description: "蜂群编队：成员花名册、信箱、任务板与目标管理。",
      methods: [
        "members",
        "spawn",
        "send",
        "run",
        "interrupt",
        "inbox",
        "taskCreate",
        "taskGet",
        "taskList",
        "taskUpdate",
        "goalCreate",
        "goalGet",
        "goalUpdate",
        "goalRound",
      ],
    },
    provider: {
      members(): MemberView[] {
        return team.listMembers();
      },
      spawn(...params: unknown[]): MemberView {
        const name = asString(params[0], "name");
        const description = asString(params[2], "description");
        const role = typeof params[1] === "string" ? params[1] : "worker";
        const prompt = typeof params[3] === "string" ? params[3] : undefined;
        return team.spawn({ name, role, description, prompt });
      },
      send(...params: unknown[]): TeamMessage {
        const from = asString(params[0], "from");
        const to = asString(params[1], "to");
        const content = asString(params[2], "content");
        return team.send(from, to, content);
      },
      async run(...params: unknown[]): Promise<unknown> {
        const name = asString(params[0], "name");
        const result = await team.runTurn(name, runner);
        if (result.outcome === undefined) {
          return { member: result.member, inbox: result.inbox, error: result.member.diagnostics[0] ?? "运行失败" };
        }
        const guarded = await guardTurn(result.outcome.text);
        return {
          member: result.member,
          inbox: result.inbox,
          outcome: { ...result.outcome, text: guarded.text },
          review: guarded.review,
        };
      },
      interrupt(...params: unknown[]): MemberView {
        return team.interrupt(asString(params[0], "name"));
      },
      inbox(...params: unknown[]): TeamMessage[] {
        return team.inbox(asString(params[0], "name"));
      },
      taskCreate(...params: unknown[]): TeamTaskView {
        const subject = asString(params[0], "subject");
        const description = typeof params[1] === "string" ? params[1] : "";
        const blockedBy = Array.isArray(params[2]) ? (params[2] as string[]) : [];
        const writeScopes = Array.isArray(params[3]) ? (params[3] as string[]) : [];
        return team.board.create(subject, description, blockedBy, writeScopes);
      },
      taskGet(...params: unknown[]): TeamTaskView {
        return team.board.get(asString(params[0], "taskId"));
      },
      taskList(): TeamTaskView[] {
        return team.board.list();
      },
      taskUpdate(...params: unknown[]): TeamTaskView {
        const taskId = asString(params[0], "taskId");
        const expectedRevision = asNumber(params[1], "expectedRevision");
        const action = asString(params[2], "action");
        const patch = (params[3] ?? {}) as Record<string, unknown>;
        return team.board.update({
          taskId,
          expectedRevision,
          action: action as never,
          actor: typeof patch.actor === "string" ? patch.actor : "lead",
          ...(typeof patch.subject === "string" ? { subject: patch.subject } : {}),
          ...(typeof patch.description === "string" ? { description: patch.description } : {}),
          ...(Array.isArray(patch.blockedBy) ? { blockedBy: patch.blockedBy as string[] } : {}),
          ...(Array.isArray(patch.writeScopes) ? { writeScopes: patch.writeScopes as string[] } : {}),
          ...(typeof patch.owner === "string" ? { owner: patch.owner } : {}),
        });
      },
      goalCreate(...params: unknown[]): Goal {
        const objective = asString(params[0], "objective");
        const maxRounds = typeof params[1] === "number" ? params[1] : undefined;
        return maxRounds === undefined ? team.goals.create(objective) : team.goals.create(objective, maxRounds);
      },
      goalGet(): Goal | undefined {
        return team.goals.get();
      },
      goalUpdate(...params: unknown[]): Goal {
        const action = asString(params[0], "action");
        const patch = (params[1] ?? {}) as Record<string, unknown>;
        switch (action) {
          case "edit":
            return team.goals.edit({
              ...(typeof patch.objective === "string" ? { objective: patch.objective } : {}),
              ...(typeof patch.maxGoalRounds === "number" ? { maxGoalRounds: patch.maxGoalRounds } : {}),
            });
          case "pause":
            return team.goals.pause();
          case "resume":
            return team.goals.resume();
          case "complete":
            return team.goals.complete();
          case "blocked": {
            const code = asString(patch.code, "code");
            const message = asString(patch.message, "message");
            return team.goals.blocked({ code, message });
          }
          default:
            throw new Error(`goalUpdate 只接受 edit/pause/resume/complete/blocked，收到：${action}`);
        }
      },
      /** 目标续轮：lead 领一轮，输出经评估模型守卫后记录进展。 */
      async goalRound(): Promise<unknown> {
        const round = team.goals.beginRound();
        const goal = team.goals.get();
        const prompt = renderGoalRoundPrompt(round, goal?.progress ?? []);
        let outcome: TurnOutcome;
        try {
          outcome = await runner({
            name: "lead",
            system: `你是蜂群主控 lead，正在朝既定目标推进。只输出本轮工作总结与下一步。`,
            message: prompt,
          });
        } catch (error) {
          team.goals.blocked({
            code: "lead-turn-failed",
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        const guarded = await guardTurn(outcome.text);
        team.goals.recordRound(round.round, guarded.text);
        const after = team.goals.get();
        return {
          round: round.round,
          maxGoalRounds: round.maxGoalRounds,
          outcome: { ...outcome, text: guarded.text },
          review: guarded.review,
          goal: after,
        };
      },
    },
  };
}
