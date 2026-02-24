import { z } from "zod";

export const configSchema = z.object({
  gateway: z.object({
    port: z.number().default(18789),
    host: z.string().default("127.0.0.1"),
    authToken: z.string().optional(),
  }).default({}),

  agent: z.object({
    defaultProvider: z.enum(["openai", "anthropic"]).default("openai"),
    systemPrompt: z.string().default(
      "You are OpenAgent, a helpful personal AI assistant. Be concise, accurate, and friendly."
    ),
    maxHistoryMessages: z.number().default(50),
  }).default({}),

  providers: z.object({
    openai: z.object({
      apiKey: z.string().default(""),
      baseUrl: z.string().default("https://api.openai.com/v1"),
      model: z.string().default("gpt-4o"),
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
    telegram: z.object({
      enabled: z.boolean().default(false),
      botToken: z.string().default(""),
    }).default({}),
  }).default({}),

  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }).default({}),

  storage: z.object({
    dbPath: z.string().default("./data/openagent.db"),
  }).default({}),
});

export type AppConfig = z.infer<typeof configSchema>;
