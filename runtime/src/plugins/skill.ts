import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RuntimeConfig } from "../config.ts";
import type { CapabilityPlugin, Provider } from "../capabilities/types.ts";
import { RuntimeError } from "../core/errors.ts";

/** 技能摘要：列表返回的元信息。 */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** 业务分类：如 账务 / 风控 / 合规；空串视为未分类。 */
  category: string;
  /** 触发词：匹配会话话术时优先命中。 */
  triggers: string[];
  bytes: number;
  updatedAt: string;
}

/** 单个技能：摘要加正文。 */
export interface Skill extends SkillSummary {
  content: string;
}

/** 技能匹配命中：分数与命中片段。 */
export interface SkillHit {
  id: string;
  name: string;
  description: string;
  score: number;
  excerpt: string;
}

/** 前置元信息块：--- 行、键值行、--- 行。 */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 命中片段：命中词前后各取 40 字。 */
const EXCERPT_RADIUS = 40;
/** name 为纯描述片段时的最大长度。 */
const EXCERPT_MAX = 80;
/** 计分权重：名称 > 标签 > 说明 > 正文。 */
const NAME_WEIGHT = 8;
const TAG_WEIGHT = 6;
const DESCRIPTION_WEIGHT = 4;
const BODY_WEIGHT = 1;
/** 单个词在同一字段的计分次数上限。 */
const FIELD_HIT_CAP = 3;
const BODY_HIT_CAP = 10;
const MATCH_LIMIT_DEFAULT = 10;
const MATCH_LIMIT_MAX = 50;
const SLUG_MAX = 64;

/** 列表条数归一化：缺失或非法取默认值，并按上限截断。 */
function positiveLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(parsed, max));
}

/** 技能 id：由 name 生成安全 slug；纯符号名无法生成时按无效输入拒绝。 */
function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
  if (slug === "") throw new RuntimeError("INVALID_INPUT", `技能名无法生成 id：${name}`);
  return slug;
}

/** YAML 标量：普通字符直接写，含特殊字符时用双引号转义。 */
function yamlScalar(value: string): string {
  return /^[\w\u4e00-\u9fff][\w\u4e00-\u9fff .,()、，。：/+-]*$/.test(value) ? value : JSON.stringify(value);
}

/** 解析 YAML 标量：双引号走 JSON 反转义，单引号去引号，其余去空白。 */
function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.replace(/^"|"$/g, "");
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1);
  return value;
}

/** 解析 tags：支持 [a, b] 行内数组与逗号分隔两种写法。 */
function parseTags(raw: string | undefined): string[] {
  const value = (raw ?? "").trim();
  if (value === "") return [];
  const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return inner
    .split(",")
    .map((item) => parseScalar(item))
    .filter((item) => item !== "");
}

/** 校验 tags 参数：字符串数组，去空白去重。 */
function normalizeTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new RuntimeError("INVALID_INPUT", "tags 必须是字符串数组");
  }
  return [...new Set(value.map((tag) => (tag as string).trim()).filter((tag) => tag !== ""))];
}

/** 读取一个技能文件：前置元信息缺失时按纯正文处理，name 回落为文件 id。 */
function readSkill(id: string, absolutePath: string): Skill {
  const raw = readFileSync(absolutePath, "utf8");
  const match = FRONT_MATTER.exec(raw);
  const meta = new Map<string, string>();
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index <= 0) continue;
      meta.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1));
    }
  }
  const stats = statSync(absolutePath);
  return {
    id,
    name: parseScalar(meta.get("name") ?? "") || id,
    description: parseScalar(meta.get("description") ?? ""),
    tags: parseTags(meta.get("tags")),
    category: parseScalar(meta.get("category") ?? ""),
    triggers: parseTags(meta.get("triggers")),
    content: match ? raw.slice(match[0].length).replace(/^\r?\n/, "") : raw,
    bytes: stats.size,
    updatedAt: stats.mtime.toISOString(),
  };
}

/** 序列化技能文件：前置元信息 + 空行 + 正文。 */
function serializeSkill(skill: {
  name: string;
  description: string;
  tags: string[];
  category: string;
  triggers: string[];
  content: string;
}): string {
  const tags = `[${skill.tags.map((tag) => yamlScalar(tag)).join(", ")}]`;
  const triggers = `[${skill.triggers.map((trigger) => yamlScalar(trigger)).join(", ")}]`;
  const category = skill.category === "" ? "" : `\ncategory: ${yamlScalar(skill.category)}`;
  return `---\nname: ${yamlScalar(skill.name)}\ndescription: ${yamlScalar(skill.description)}\ntags: ${tags}${category}\ntriggers: ${triggers}\n---\n\n${skill.content}`;
}

/** 命中次数：同一词最多计 FIELD_HIT_CAP/BODY_HIT_CAP 次，避免长正文淹没权重。 */
function occurrences(haystack: string, needle: string, cap: number): number {
  if (needle === "") return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < cap) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 命中片段：命中词前后各 40 字，折叠空白并在截断处补省略号。 */
function excerptAround(content: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(content.length, index + length + EXCERPT_RADIUS);
  const text = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${end < content.length ? "…" : ""}`;
}

/** 无正文命中时的片段：取自说明。 */
function descriptionExcerpt(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  return text.length <= EXCERPT_MAX ? text : `${text.slice(0, EXCERPT_MAX)}…`;
}

/** 按 name/description/tags/正文关键词计分；无任何命中时分数为 0。 */
function scoreSkill(skill: Skill, query: string): { skill: Skill; score: number; excerpt: string } {
  const needle = query.toLowerCase();
  const terms = [...new Set(needle.split(/[\s,，、;；/|]+/).filter(Boolean))];
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  const tags = skill.tags.map((tag) => tag.toLowerCase());
  const body = skill.content.toLowerCase();
  let score = 0;
  let bodyIndex = -1;
  let bodyTerm = "";
  for (const term of terms) {
    score += NAME_WEIGHT * occurrences(name, term, FIELD_HIT_CAP);
    score += TAG_WEIGHT * (tags.some((tag) => tag.includes(term)) ? 1 : 0);
    score += DESCRIPTION_WEIGHT * occurrences(description, term, FIELD_HIT_CAP);
    const hits = occurrences(body, term, BODY_HIT_CAP);
    score += BODY_WEIGHT * hits;
    if (hits > 0 && bodyIndex < 0) {
      bodyIndex = body.indexOf(term);
      bodyTerm = term;
    }
  }
  if (name.includes(needle)) score += NAME_WEIGHT;
  if (bodyIndex < 0 && body.includes(needle)) {
    bodyIndex = body.indexOf(needle);
    bodyTerm = needle;
  }
  const excerpt = bodyIndex >= 0
    ? excerptAround(skill.content, bodyIndex, bodyTerm.length)
    : descriptionExcerpt(skill.description);
  return { skill, score, excerpt };
}

/** 扫描技能目录：目录不存在返回空数组，按 id 排序。供插件与模型工具共用。 */
export function readSkillDirectory(skillsDir: string): Skill[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => path.join(skillsDir, entry.name))
    .filter((absolute) => statSync(absolute).isFile())
    .map((absolute) => readSkill(path.basename(absolute, path.extname(absolute)), absolute))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 技能能力 "skill"：把业务流程与配方做成可按需加载的技能文件。
 *
 * - 技能存放在 skillsDir，一个技能一个 .md 文件，前置元信息记录 name/description/tags。
 * - id 由 name 生成安全 slug，读写删都限制在技能目录内，符号链接逃逸与越界按 ACCESS_DENIED 拒绝。
 * - 目录不存在视为空技能库，列表返回空数组。
 */
export function createSkillPlugin(cfg: RuntimeConfig): CapabilityPlugin {
  const skillsDir = path.resolve(cfg.skillsDir);

  /** 技能 id → 目录内文件路径；分隔符、绝对路径与符号链接逃逸都拒绝。 */
  const resolveInside = (skillId: unknown): { id: string; absolute: string } => {
    if (typeof skillId !== "string" || skillId.trim() === "") {
      throw new RuntimeError("INVALID_INPUT", "skill 需要 skillId");
    }
    const id = skillId.trim();
    if (id.includes("/") || id.includes("\\") || path.isAbsolute(id)) {
      throw new RuntimeError("ACCESS_DENIED", `技能 id 越界：${id}`);
    }
    const absolute = path.resolve(skillsDir, `${id}.md`);
    const realRoot = existsSync(skillsDir) ? realpathSync(skillsDir) : skillsDir;
    const probe = existsSync(absolute) ? realpathSync(absolute) : absolute;
    if (probe !== realRoot && !probe.startsWith(realRoot + path.sep)) {
      throw new RuntimeError("ACCESS_DENIED", `技能 id 越界：${id}`);
    }
    return { id, absolute };
  };

  /** 已存在的技能文件：越界按 ACCESS_DENIED 拒绝，不存在按 NOT_FOUND 拒绝。 */
  const requireFile = (skillId: unknown): { id: string; absolute: string } => {
    const target = resolveInside(skillId);
    if (!existsSync(target.absolute) || !statSync(target.absolute).isFile()) {
      throw new RuntimeError("NOT_FOUND", `技能不存在：${target.id}`);
    }
    return target;
  };

  /** 扫描技能目录：目录不存在返回空数组，按 id 排序。 */
  const listSkills = (): Skill[] => readSkillDirectory(skillsDir);

  const provider: Provider = {
    /** 技能清单：目录不存在时为空列表。 */
    list: (): { skills: SkillSummary[] } => ({
      skills: listSkills().map(({ content: _content, ...summary }) => summary),
    }),

    /** 读取技能正文；不存在按 NOT_FOUND 拒绝。 */
    read: (...params: unknown[]): { skill: Skill } => {
      const target = requireFile(params[0]);
      return { skill: readSkill(target.id, target.absolute) };
    },

    /** 关键词匹配：按 name/description/tags/正文计分排序，只返回真实命中。 */
    match: (...params: unknown[]): { skills: SkillHit[] } => {
      const query = typeof params[0] === "string" ? params[0].trim() : "";
      if (query === "") throw new RuntimeError("INVALID_INPUT", "skill.registry.match 需要非空 query");
      const limit = positiveLimit(params[1], MATCH_LIMIT_DEFAULT, MATCH_LIMIT_MAX);
      return {
        skills: listSkills()
          .map((skill) => scoreSkill(skill, query))
          .filter((hit) => hit.score > 0)
          .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
          .slice(0, limit)
          .map((hit) => ({
            id: hit.skill.id,
            name: hit.skill.name,
            description: hit.skill.description,
            score: hit.score,
            excerpt: hit.excerpt,
          })),
      };
    },

    /** 关键词搜索：与 match 同一套计分，供技能中心面板检索。 */
    search: (...params: unknown[]): { skills: SkillHit[] } => provider.match(...params) as { skills: SkillHit[] },

    /** 新建技能：id 由 name 生成 slug，同名已存在按无效输入拒绝。 */
    create: (...params: unknown[]): { skill: Skill } => {
      const name = typeof params[0] === "string" ? params[0].trim() : "";
      if (name === "") throw new RuntimeError("INVALID_INPUT", "skill.registry.create 需要非空 name");
      const description = typeof params[1] === "string" ? params[1].trim() : "";
      const content = typeof params[2] === "string" ? params[2] : "";
      const tags = normalizeTags(params[3]);
      const category = typeof params[4] === "string" ? params[4].trim() : "";
      const triggers = normalizeTags(params[5]);
      const id = slugify(name);
      const absolute = path.join(skillsDir, `${id}.md`);
      if (existsSync(absolute)) throw new RuntimeError("INVALID_INPUT", `同名技能已存在：${id}`);
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(absolute, serializeSkill({ name, description, tags, category, triggers, content }), "utf8");
      return { skill: readSkill(id, absolute) };
    },

    /** 更新技能：只接受 description/content/tags，name 不可改。 */
    update: (...params: unknown[]): { skill: Skill } => {
      const target = requireFile(params[0]);
      const current = readSkill(target.id, target.absolute);
      const patch = params[1];
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        throw new RuntimeError("INVALID_INPUT", "skill.registry.update 需要 patch 对象");
      }
      const fields = patch as Record<string, unknown>;
      if (fields.name !== undefined && fields.name !== current.name) {
        throw new RuntimeError("INVALID_INPUT", "技能 name 不可修改");
      }
      if (fields.description !== undefined && typeof fields.description !== "string") {
        throw new RuntimeError("INVALID_INPUT", "description 必须是字符串");
      }
      if (fields.content !== undefined && typeof fields.content !== "string") {
        throw new RuntimeError("INVALID_INPUT", "content 必须是字符串");
      }
      const description = fields.description === undefined ? current.description : fields.description.trim();
      const content = fields.content === undefined ? current.content : fields.content;
      const tags = fields.tags === undefined ? current.tags : normalizeTags(fields.tags);
      if (fields.category !== undefined && typeof fields.category !== "string") {
        throw new RuntimeError("INVALID_INPUT", "category 必须是字符串");
      }
      const category = fields.category === undefined ? current.category : fields.category.trim();
      const triggers = fields.triggers === undefined ? current.triggers : normalizeTags(fields.triggers);
      writeFileSync(target.absolute, serializeSkill({ name: current.name, description, tags, category, triggers, content }), "utf8");
      return { skill: readSkill(target.id, target.absolute) };
    },

    /** 删除技能：只删技能目录内的那个文件。 */
    remove: (...params: unknown[]): { ok: true; path: string } => {
      const target = requireFile(params[0]);
      rmSync(target.absolute, { force: true });
      return { ok: true, path: target.absolute };
    },
  };

  return {
    name: "skill",
    def: {
      service: "skill.registry",
      methods: ["list", "read", "match", "search", "create", "update", "remove"],
      description: "技能中心：银行业务流程与配方，按分类/触发词/关键词检索",
    },
    panel: {
      title: "技能中心",
      description: "银行业务流程与配方",
      kind: "summary",
      source: "skill.list",
    },
    provider,
  };
}

export default createSkillPlugin;
