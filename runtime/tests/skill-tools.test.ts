import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAgentPrompt,
  createSkillLoader,
  renderSkillCatalog,
  skillLoadDescriptor,
} from "../src/bank/skill-tools.ts";
import { readSkillDirectory } from "../src/plugins/skill.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cordibank-skills-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSkill(id: string, name: string, description: string, body: string): void {
  const text = `---\nname: ${name}\ndescription: ${description}\ntags: [测试]\n---\n\n${body}`;
  writeFileSync(path.join(dir, `${id}.md`), text, "utf8");
}

describe("技能目录", () => {
  it("新增技能文件即出现在目录里", () => {
    writeSkill("01-a", "转账规范", "判断转账是否放行", "# 转账规范\n\n正文");
    writeSkill("02-b", "对账口径", "账单统计口径", "# 对账口径\n\n正文");
    const skills = readSkillDirectory(dir);
    expect(skills.map((item) => item.name)).toEqual(["转账规范", "对账口径"]);
  });

  it("目录摘要一行一个技能且截断说明", () => {
    writeSkill("01-a", "转账规范", "很长的一段说明".repeat(20), "# 正文");
    const catalog = renderSkillCatalog(readSkillDirectory(dir));
    expect(catalog).toContain("转账规范");
    expect(catalog.split("\n").length).toBe(1);
    expect(catalog.length).toBeLessThan(200);
  });

  it("空目录时提示词只保留边界，不出现技能段", () => {
    const prompt = buildAgentPrompt(renderSkillCatalog(readSkillDirectory(dir)));
    expect(prompt).not.toContain("可用技能");
  });

  it("有技能时提示词追加目录并指明加载方式", () => {
    writeSkill("01-a", "转账规范", "判断转账是否放行", "# 正文");
    const prompt = buildAgentPrompt(renderSkillCatalog(readSkillDirectory(dir)));
    expect(prompt).toContain("可用技能");
    expect(prompt).toContain("转账规范");
    expect(prompt).toContain("skill_load");
  });
});

describe("技能加载工具", () => {
  it("描述符是只读绿级工具", () => {
    const descriptor = skillLoadDescriptor();
    expect(descriptor.risk.level).toBe("green");
    expect(descriptor.risk.write).toBe(false);
    expect(descriptor.parameters.required).toEqual(["name"]);
  });

  it("按名字加载返回正文", async () => {
    writeSkill("01-a", "转账规范", "判断转账是否放行", "# 转账规范\n\n单笔 1000 元以上拦截。");
    const skills = readSkillDirectory(dir);
    const result = await createSkillLoader(skills)({ name: "转账规范" });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("单笔 1000 元以上拦截");
  });

  it("名字不存在时给出可用清单", async () => {
    writeSkill("01-a", "转账规范", "判断转账是否放行", "# 正文");
    const result = await createSkillLoader(readSkillDirectory(dir))({ name: "不存在的技能" });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("转账规范");
  });

  it("超长正文被截断并标注", async () => {
    writeSkill("01-a", "长文", "很长的技能", "内容".repeat(4000));
    const result = await createSkillLoader(readSkillDirectory(dir))({ name: "长文" });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("已截断");
  });
});
