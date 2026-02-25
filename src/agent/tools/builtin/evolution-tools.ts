import type { ToolHandler } from "../../../types";
import { getMemoryStore } from "../../../evolution/memory";
import { getSkillLoader } from "../../../evolution/skill-loader";
import { getSelfModifier } from "../../../evolution/self-modify";

/**
 * Update a section in SOUL.md, USER.md, or WORLD.md.
 */
export const memoryUpdateTool: ToolHandler = {
  definition: {
    name: "memory_update",
    description:
      "Update a section in the agent's persistent memory files (SOUL, USER, or WORLD). " +
      "Use this to record learned behaviors, user preferences, or world knowledge.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Which memory file: SOUL, USER, or WORLD",
        },
        section: {
          type: "string",
          description: "Section heading to update (e.g. 'Learned Behaviors', 'Preferences')",
        },
        content: {
          type: "string",
          description: "New content for the section",
        },
      },
      required: ["file", "section", "content"],
    },
  },

  async execute(args) {
    const file = args.file as "SOUL" | "USER" | "WORLD";
    const section = args.section as string;
    const content = args.content as string;

    if (!["SOUL", "USER", "WORLD"].includes(file)) {
      return JSON.stringify({ error: "file must be SOUL, USER, or WORLD" });
    }

    const memory = getMemoryStore();
    await memory.updateSection(file, section, content);
    return JSON.stringify({ updated: `${file}.md`, section });
  },
};

/**
 * Append a timestamped entry to a memory section.
 */
export const memoryAppendTool: ToolHandler = {
  definition: {
    name: "memory_append",
    description:
      "Append a timestamped entry to a section in a memory file. " +
      "Good for logging events, notes, or observations.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Which memory file: SOUL, USER, or WORLD",
        },
        section: {
          type: "string",
          description: "Section heading to append to",
        },
        entry: {
          type: "string",
          description: "Entry text (timestamp will be auto-prepended)",
        },
      },
      required: ["file", "section", "entry"],
    },
  },

  async execute(args) {
    const file = args.file as "SOUL" | "USER" | "WORLD";
    const section = args.section as string;
    const entry = args.entry as string;

    if (!["SOUL", "USER", "WORLD"].includes(file)) {
      return JSON.stringify({ error: "file must be SOUL, USER, or WORLD" });
    }

    const memory = getMemoryStore();
    await memory.appendEntry(file, section, entry);
    return JSON.stringify({ appended: `${file}.md`, section });
  },
};

/**
 * Read a memory file.
 */
export const memoryReadTool: ToolHandler = {
  definition: {
    name: "memory_read",
    description:
      "Read the full content of a memory file (SOUL, USER, or WORLD).",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Which memory file: SOUL, USER, or WORLD",
        },
      },
      required: ["file"],
    },
  },

  async execute(args) {
    const file = args.file as "SOUL" | "USER" | "WORLD";
    if (!["SOUL", "USER", "WORLD"].includes(file)) {
      return JSON.stringify({ error: "file must be SOUL, USER, or WORLD" });
    }
    const memory = getMemoryStore();
    return await memory.read(file);
  },
};

/**
 * Create a new dynamic skill script.
 */
export const skillCreateTool: ToolHandler = {
  definition: {
    name: "skill_create",
    description:
      "Create a new dynamic skill script in user-space/skills/. " +
      "The script must export a default object with { name, description, parameters, execute }. " +
      "Filename should end with .skill.ts.",
    parameters: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Skill filename (e.g. 'my-tool.skill.ts')",
        },
        source: {
          type: "string",
          description: "Full TypeScript source code for the skill",
        },
      },
      required: ["filename", "source"],
    },
  },

  async execute(args) {
    const filename = args.filename as string;
    const source = args.source as string;

    try {
      const loader = getSkillLoader();
      const path = await loader.createSkill(filename, source);
      const handler = await loader.hotReload(
        filename.endsWith(".skill.ts") ? filename : `${filename}.skill.ts`,
      );

      return JSON.stringify({
        created: path,
        loaded: !!handler,
        toolName: handler?.definition.name ?? null,
      });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

/**
 * List and reload dynamic skills.
 */
export const skillListTool: ToolHandler = {
  definition: {
    name: "skill_list",
    description: "List all available dynamic skill scripts.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  async execute() {
    const loader = getSkillLoader();
    const files = loader.listSkillFiles();
    const loaded = loader.getLoaded().map((h) => h.definition.name);
    return JSON.stringify({ files, loaded });
  },
};

/**
 * Self-modify: write or update a source file (within safety boundaries).
 */
export const selfModifyTool: ToolHandler = {
  definition: {
    name: "self_modify",
    description:
      "Modify a source file within the project (restricted to safe paths). " +
      "Allowed: user-space/**, src/agent/tools/builtin/**, config/**. " +
      "Denied: src/evolution/**, src/config/**, src/gateway/server.ts, etc. " +
      "Use with care. Always provide a rationale.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to project root",
        },
        content: {
          type: "string",
          description: "Full new file content",
        },
        rationale: {
          type: "string",
          description: "Why this modification is needed",
        },
      },
      required: ["path", "content", "rationale"],
    },
  },

  async execute(args) {
    const path = args.path as string;
    const content = args.content as string;
    const rationale = args.rationale as string;

    const modifier = getSelfModifier();
    const result = await modifier.modify(path, content, rationale);
    return JSON.stringify(result);
  },
};
