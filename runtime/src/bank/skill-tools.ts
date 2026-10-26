import type { ToolDescriptor } from "../harness/types.ts";
import { AGENT_SYSTEM_PROMPT } from "../llm/prompts.ts";
import type { Skill } from "../plugins/skill.ts";

/** 目录里每条技能摘要的字符上限，控制系统提示词体积。 */
export const CATALOG_LINE_MAX = 80;

/** 单次加载正文的字符上限，超出截断并标注。 */
export const SKILL_BODY_MAX = 4000;

/** 技能目录摘要：一行一个技能，只给名字与一句话。 */
export function renderSkillCatalog(skills: Skill[]): string {
  return skills
    .map((skill) => {
      const summary = skill.description.replace(/\s+/g, " ").trim().slice(0, CATALOG_LINE_MAX);
      return `- ${skill.name}：${summary === "" ? "无说明" : summary}`;
    })
    .join("\n");
}

/** 对话层系统提示词：固定边界加动态技能目录。目录为空时退回纯边界。 */
export function buildAgentPrompt(catalog: string): string {
  if (catalog === "") return AGENT_SYSTEM_PROMPT;
  return [
    AGENT_SYSTEM_PROMPT,
    "",
    "【可用技能】",
    catalog,
    "遇到技能覆盖的任务时先调用 skill_load 取全文，按其中的规范执行。",
  ].join("\n");
}

/** 技能加载工具：模型按需取全文，渐进披露的第一步只给目录。 */
export function skillLoadDescriptor(): ToolDescriptor {
  return {
    name: "skill_load",
    summary: "加载某个技能的完整规范，参数 name 取技能目录里的名字",
    source: "builtin",
    scene: "any",
    risk: { level: "green", reversible: true, write: false },
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "技能名称" } },
      required: ["name"],
      additionalProperties: false,
    },
  };
}

/** 技能加载执行器：按名字匹配，未命中给出可用清单。 */
export function createSkillLoader(skills: Skill[]): (args: Record<string, unknown>) => Promise<{ ok: boolean; summary: string }> {
  return async (args) => {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (name === "") return { ok: false, summary: "缺少参数：name" };
    const skill = skills.find((item) => item.name === name || item.id === name);
    if (skill === undefined) {
      const names = skills.map((item) => item.name).join("、");
      return { ok: false, summary: `没有这个技能：${name}。可用：${names}` };
    }
    const body = skill.content.trim();
    const text = body.length <= SKILL_BODY_MAX ? body : `${body.slice(0, SKILL_BODY_MAX)}……（已截断，原文 ${body.length} 字符）`;
    return { ok: true, summary: `【${skill.name}】\n${text}` };
  };
}
