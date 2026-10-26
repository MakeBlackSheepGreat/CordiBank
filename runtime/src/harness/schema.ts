import type { ToolDescriptor } from "./types.ts";

/** 槽位定义：与业务契约保持结构兼容，避免框架层反向依赖业务层。 */
export interface SlotLike {
  kind: "string" | "integer" | "enum";
  description: string;
  required: boolean;
  values?: readonly string[];
  min?: number;
  max?: number;
  maxLength?: number;
}

/** 把槽位契约转成 JSON Schema 对象。 */
export function slotsSchema(slots: Record<string, SlotLike>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(slots)) {
    const prop: Record<string, unknown> = {
      type: spec.kind === "integer" ? "integer" : "string",
      description: spec.description,
    };
    if (spec.kind === "enum" && spec.values !== undefined) prop.enum = [...spec.values];
    if (spec.min !== undefined) prop.minimum = spec.min;
    if (spec.max !== undefined) prop.maximum = spec.max;
    if (spec.maxLength !== undefined) prop.maxLength = spec.maxLength;
    properties[name] = prop;
    if (spec.required) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

export interface ToolDeclaration {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 把描述符转成请求体的 tools 声明。 */
export function toDeclaration(descriptor: ToolDescriptor): ToolDeclaration {
  return {
    type: "function",
    function: {
      name: descriptor.name,
      description: descriptor.summary,
      parameters: descriptor.parameters,
    },
  };
}

export function toDeclarations(descriptors: ToolDescriptor[]): ToolDeclaration[] {
  return descriptors.map(toDeclaration);
}
