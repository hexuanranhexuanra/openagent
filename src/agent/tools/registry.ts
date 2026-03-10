import type { ToolHandler, ToolDefinition } from "../../types";
import { createLogger } from "../../logger";

const log = createLogger("tools");

const tools = new Map<string, ToolHandler>();

export function registerTool(handler: ToolHandler): void {
  if (tools.has(handler.definition.name)) {
    log.warn("Tool already registered, overwriting", { name: handler.definition.name });
  }
  tools.set(handler.definition.name, handler);
  log.info("Tool registered", { name: handler.definition.name });
}

export function getTool(name: string): ToolHandler | undefined {
  return tools.get(name);
}

export function getAllToolDefinitions(): ToolDefinition[] {
  return Array.from(tools.values()).map((t) => t.definition);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const handler = tools.get(name);
  if (!handler) {
    return JSON.stringify({ error: `Tool '${name}' not found` });
  }

  try {
    const raw = await handler.execute(args);
    // Coerce to string — dynamic skills may return non-strings at runtime despite the type.
    if (typeof raw === "string") return raw;
    return JSON.stringify(raw ?? "");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Tool execution failed", { name, error: message });
    return JSON.stringify({ error: message });
  }
}
