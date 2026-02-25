/**
 * Example skill: demonstrates the skill script format.
 *
 * Skills are dynamically loaded at startup and can be hot-reloaded.
 * The agent can create new skills via the skill_create tool.
 *
 * File naming: must end with .skill.ts
 * Export: must have a default export with { name, description, parameters, execute }
 */
export default {
  name: "hello",
  description: "A simple greeting skill that demonstrates the skill format",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name to greet",
      },
    },
    required: ["name"],
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const name = args.name as string;
    const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    return JSON.stringify({
      greeting: `你好 ${name}！现在是 ${now}`,
      tip: "这是一个示例技能，你可以通过 skill_create 工具创建更多技能。",
    });
  },
};
