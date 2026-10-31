import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createSkillPlugin } from "../src/plugins/skill.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cordibank-skill-plugin-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makePlugin() {
  return createSkillPlugin(loadConfig({ skillsDir: dir, storeDir: path.join(dir, "store") }));
}

describe("技能中心插件", () => {
  it("create 接受分类与触发词，list 摘要回带", async () => {
    const plugin = makePlugin();
    const created = (await plugin.provider.create(
      "转账复核",
      "大额转账的复核步骤",
      "# 步骤",
      ["风控"],
      "风控",
      ["转账", "大额"],
    )) as { skill: { id: string; category: string; triggers: string[] } };
    expect(created.skill.id).toBe("转账复核");
    expect(created.skill.category).toBe("风控");
    expect(created.skill.triggers).toEqual(["转账", "大额"]);

    const list = (await plugin.provider.list()) as { skills: Array<{ id: string; category: string; triggers: string[] }> };
    expect(list.skills).toHaveLength(1);
    expect(list.skills[0].category).toBe("风控");
    expect(list.skills[0].triggers).toEqual(["转账", "大额"]);
  });

  it("update 可改分类与触发词，category 必须是字符串", async () => {
    const plugin = makePlugin();
    await plugin.provider.create("对账", "账单口径", "# 内容", [], "账务", ["对账"]);
    const updated = (await plugin.provider.update("对账", {
      category: "合规",
      triggers: ["月度对账"],
    })) as { skill: { category: string; triggers: string[] } };
    expect(updated.skill.category).toBe("合规");
    expect(updated.skill.triggers).toEqual(["月度对账"]);

    await expect(
      Promise.resolve().then(() => plugin.provider.update("对账", { category: 123 })),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("search 与 match 同一套计分，能命中触发词与分类", async () => {
    const plugin = makePlugin();
    await plugin.provider.create(
      "外汇换算",
      "外币金额按汇率换算成人民币",
      "# 换算规则",
      ["工具"],
      "账务",
      ["汇率", "外汇"],
    );
    const hit = (await plugin.provider.search("外汇 汇率")) as {
      skills: Array<{ id: string; score: number }>;
    };
    expect(hit.skills.length).toBeGreaterThan(0);
    expect(hit.skills[0].id).toBe("外汇换算");
    const miss = (await plugin.provider.search("量子加密")) as { skills: Array<{ id: string }> };
    expect(miss.skills).toHaveLength(0);
  });

  it("未写分类的技能 category 为空串，序列化不再回写 category 行", async () => {
    const plugin = makePlugin();
    await plugin.provider.create("朴素技能", "只有名字和描述", "# 正文");
    const read = (await plugin.provider.read("朴素技能")) as { skill: { category: string; triggers: string[] } };
    expect(read.skill.category).toBe("");
    expect(read.skill.triggers).toEqual([]);
    const raw = readFileSync(path.join(dir, "朴素技能.md"), "utf8");
    expect(raw).toContain("triggers: []");
    expect(raw).not.toContain("category:");
  });
});
