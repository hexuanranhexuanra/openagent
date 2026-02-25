import { z } from "zod";

export const configSchema = z.object({
  gateway: z.object({
    port: z.number().default(19090),
    host: z.string().default("127.0.0.1"),
    authToken: z.string().optional(),
  }).default({}),

  agent: z.object({
    defaultProvider: z.enum(["openai", "anthropic"]).default("openai"),
    systemPrompt: z.string().default(
      "You are OpenAgent, a self-evolving personal AI assistant. " +
      "You can use tools to help the user, remember things across sessions, " +
      "create new skills, and even modify your own code. " +
      "Be concise, accurate, and proactive about learning from interactions."
    ),
    maxHistoryMessages: z.number().default(50),
    maxToolRounds: z.number().default(10),
  }).default({}),

  providers: z.object({
    openai: z.object({
      apiKey: z.string().default(""),
      baseUrl: z.string().default("https://api.openai.com/v1"),
      model: z.string().default("gpt-4o"),
      /** Extra query params appended to every request (e.g. { ak: "..." } for ByteDance GenAI) */
      queryParams: z.record(z.string()).default({}),
    }).default({}),
    anthropic: z.object({
      apiKey: z.string().default(""),
      model: z.string().default("claude-sonnet-4-20250514"),
    }).default({}),
  }).default({}),

  channels: z.object({
    webchat: z.object({
      enabled: z.boolean().default(true),
    }).default({}),
    feishu: z.object({
      enabled: z.boolean().default(false),
      appId: z.string().default(""),
      appSecret: z.string().default(""),
      encryptKey: z.string().default(""),
      verificationToken: z.string().default(""),
    }).default({}),
    telegram: z.object({
      enabled: z.boolean().default(false),
      botToken: z.string().default(""),
    }).default({}),
  }).default({}),

  evolution: z.object({
    memoryPath: z.string().default("./user-space/memory"),
    skillsPath: z.string().default("./user-space/skills"),
    selfModifyEnabled: z.boolean().default(true),
    reflectionEnabled: z.boolean().default(true),
  }).default({}),

  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }).default({}),

  storage: z.object({
    dbPath: z.string().default("./data/openagent.db"),
  }).default({}),
});

export type AppConfig = z.infer<typeof configSchema>;
