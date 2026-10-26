import { slotsSchema } from "../harness/schema.ts";
import type { ToolDescriptor } from "../harness/types.ts";
import { TOOL_SPECS } from "./policy.ts";
import { TOOL_CONTRACTS, WRITE_TOOL_NAMES } from "./tool-schema.ts";

/** 内置工具描述符：由策略表与参数契约合成，两者是唯一事实来源。 */
export function builtinToolDescriptors(): ToolDescriptor[] {
  return TOOL_SPECS.map((spec) => {
    const contract = TOOL_CONTRACTS[spec.tool];
    return {
      name: spec.tool,
      summary: spec.description,
      source: "builtin" as const,
      scene: spec.scene,
      risk: {
        level: spec.baseLevel,
        reversible: spec.reversible,
        write: WRITE_TOOL_NAMES.has(spec.tool),
      },
      parameters:
        contract === undefined
          ? { type: "object", properties: {}, required: [], additionalProperties: false }
          : slotsSchema(contract.slots),
    };
  });
}
