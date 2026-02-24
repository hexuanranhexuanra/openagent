const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>) {
  if (!shouldLog(level)) return;

  const entry = {
    ts: formatTimestamp(),
    level,
    scope,
    msg: message,
    ...(data ? { data } : {}),
  };

  const line = JSON.stringify(entry);

  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => log("debug", scope, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => log("info", scope, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => log("warn", scope, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => log("error", scope, msg, data),
  };
}
