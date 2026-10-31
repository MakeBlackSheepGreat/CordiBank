import { describe, expect, it } from "vitest";

import { GoalManager, renderGoalRoundPrompt } from "../src/bank/swarm-goal.ts";
import { SwarmTeam, type TurnOutcome } from "../src/bank/swarm-roster.ts";
import { TaskBoard, TeamError } from "../src/bank/swarm-board.ts";
import { loadConfig, type RuntimeConfig } from "../src/config.ts";
import { createSwarmTeamPlugin } from "../src/plugins/swarm-team.ts";

/** 测试专用配置：不写 store、不配密钥，模型路径全部走不到真实网络。 */
function testCfg(): RuntimeConfig {
  return loadConfig({
    storeDir: "cordibank-test-tmp/store",
    skillsDir: "cordibank-test-tmp/skills",
  });
}

describe("swarm-board 任务板", () => {
  it("创建/查询/列表与 ready 判定", () => {
    const board = new TaskBoard();
    const a = board.create("盘点工具", "清点内置与外部工具");
    const b = board.create("写报告", "汇总盘点结果", [a.id]);
    expect(b.ready).toBe(false);
    board.update({ taskId: a.id, expectedRevision: a.revision, action: "claim", actor: "lead" });
    board.update({ taskId: a.id, expectedRevision: board.get(a.id).revision, action: "complete", actor: "lead" });
    expect(board.get(b.id).ready).toBe(true);
    expect(board.list().map((t) => t.subject)).toEqual(["盘点工具", "写报告"]);
  });

  it("CAS 修订冲突报 TEAM_TASK_STALE_REVISION", () => {
    const board = new TaskBoard();
    const task = board.create("任务", "");
    expect(() => board.update({ taskId: task.id, expectedRevision: task.revision + 5, action: "claim", actor: "lead" })).toThrowError(TeamError);
  });

  it("依赖环在 set_dependencies 时报 TEAM_TASK_DEPENDENCY_CYCLE", () => {
    const board = new TaskBoard();
    const a = board.create("a", "");
    const b = board.create("b", "", [a.id]);
    expect(() =>
      board.update({ taskId: a.id, expectedRevision: a.revision, action: "set_dependencies", actor: "lead", blockedBy: [b.id] }),
    ).toThrowError(TeamError);
  });

  it("delete 需无依赖者", () => {
    const board = new TaskBoard();
    const a = board.create("被依赖", "");
    board.create("依赖者", "", [a.id]);
    expect(() => board.update({ taskId: a.id, expectedRevision: board.get(a.id).revision, action: "delete", actor: "lead" })).toThrowError(TeamError);
  });
});

describe("swarm-goal 目标管理", () => {
  it("beginRound 计轮，complete 后不再开轮", () => {
    const goals = new GoalManager();
    goals.create("完成赛题演示", 3);
    const r1 = goals.beginRound();
    expect(r1.round).toBe(1);
    goals.recordRound(r1.round, "盘点完成");
    goals.beginRound();
    goals.complete();
    expect(() => goals.beginRound()).toThrowError(TeamError);
    expect(goals.get()?.phase).toBe("complete");
  });

  it("轮数耗尽报错并提示上限", () => {
    const goals = new GoalManager();
    goals.create("只跑一轮", 1);
    goals.beginRound();
    expect(() => goals.beginRound()).toThrowError(/轮/);
  });

  it("blocked 后 resume 可恢复", () => {
    const goals = new GoalManager();
    goals.create("目标", 2);
    goals.beginRound();
    goals.blocked({ code: "lead-turn-failed", message: "模型超时" });
    expect(goals.get()?.phase).toBe("blocked");
    goals.resume();
    expect(goals.get()?.phase).toBe("active");
  });

  it("renderGoalRoundPrompt 含目标、轮次与最近进展", () => {
    const goals = new GoalManager();
    goals.create("对齐蜂群主题", 5);
    const r = goals.beginRound();
    goals.recordRound(r.round, "第一轮做了什么");
    const text = renderGoalRoundPrompt({ objective: "对齐蜂群主题", round: 2, maxGoalRounds: 5 }, goals.get()?.progress ?? []);
    expect(text).toContain("<goal_round>");
    expect(text).toContain("对齐蜂群主题");
    expect(text).toContain("第一轮做了什么");
  });
});

describe("swarm-roster 花名册与信箱", () => {
  it("spawn/送信/runTurn 排空信箱并投递", async () => {
    const team = new SwarmTeam();
    team.spawn({ name: "scout", role: "explorer", description: "外部工具侦察" });
    team.send("lead", "scout", "查一下外部汇率工具");
    const seen: string[] = [];
    const runner = async (input: { name: string; message: string }): Promise<TurnOutcome> => {
      seen.push(`${input.name}<=${input.message}`);
      return { text: "侦察完成", steps: 1, stopReason: "final" };
    };
    const result = await team.runTurn("scout", runner);
    expect(result.outcome?.text).toBe("侦察完成");
    expect(seen).toEqual(["scout<=[msg-1] 来自 lead：查一下外部汇率工具"]);
    expect(result.inbox.every((m) => m.delivered)).toBe(true);
    expect(team.member("scout").status).toBe("inactive");
  });

  it("成员上限与保留名拦截", () => {
    const team = new SwarmTeam({ maxMembers: 2 });
    team.spawn({ name: "scout", role: "explorer", description: "a" });
    expect(() => team.spawn({ name: "worker2", role: "worker", description: "b" })).toThrowError(TeamError);
    expect(() => team.spawn({ name: "lead", role: "worker", description: "c" })).toThrowError(TeamError);
  });

  it("runner 异常置 failed 并保留未投递消息", async () => {
    const team = new SwarmTeam();
    team.spawn({ name: "scout", role: "explorer", description: "a" });
    for (let i = 1; i <= 18; i += 1) team.send("lead", "scout", "消息" + i);
    const runner = async (): Promise<TurnOutcome> => {
      throw new Error("模型超时");
    };
    const result = await team.runTurn("scout", runner);
    expect(result.outcome).toBeUndefined();
    const member = result.member;
    expect(member.status).toBe("failed");
    expect(member.diagnostics[0]).toContain("模型超时");
    expect(team.inbox("scout").some((m) => m.delivered === false)).toBe(true);
  });
});

describe("swarm-team 插件服务", () => {
  it("未配密钥时任务与目标方法可用，run 明确报模型未配置", async () => {
    const plugin = createSwarmTeamPlugin(testCfg());
    const members = plugin.provider.members() as { name: string }[];
    expect(members.map((m) => m.name)).toContain("lead");
    const created = plugin.provider.taskCreate("分派侦察", "先看外部工具") as { id: string; ready: boolean };
    expect(created.ready).toBe(true);
    const goal = plugin.provider.goalCreate("完成蜂群演示", 3) as { phase: string };
    expect(goal.phase).toBe("active");
    plugin.provider.spawn("scout", "explorer", "侦察");
    const ran = await plugin.provider.run("scout") as { error?: string };
    expect(ran.error).toMatch(/模型未配置/);
  });

  it("goalRound 在无密钥时 blocked 并原样抛错", async () => {
    const plugin = createSwarmTeamPlugin(testCfg());
    plugin.provider.goalCreate("目标", 2);
    await expect(plugin.provider.goalRound()).rejects.toThrow(/模型未配置/);
    expect((plugin.provider.goalGet() as { phase: string; blockedReason?: { code: string } }).blockedReason?.code).toBe("lead-turn-failed");
  });
});
