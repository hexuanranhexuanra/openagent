import type { ToolHandler } from "../../../types";

export const dateTimeTool: ToolHandler = {
  definition: {
    name: "get_current_datetime",
    description: "Get the current date, time, and timezone information",
    parameters: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: "IANA timezone string (e.g. 'Asia/Shanghai'). Defaults to system timezone.",
        },
      },
      required: [],
    },
  },

  async execute(args) {
    const tz = (args.timezone as string) || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    const formatted = now.toLocaleString("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    return JSON.stringify({
      iso: now.toISOString(),
      formatted,
      timezone: tz,
      unixMs: now.getTime(),
    });
  },
};
