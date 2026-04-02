export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = Readonly<{
  debug: (msg: string, meta?: unknown) => void;
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
}>;

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function formatLine(level: LogLevel, msg: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  if (meta === undefined) return `[${ts}] ${level.toUpperCase()} ${msg}`;
  try {
    return `[${ts}] ${level.toUpperCase()} ${msg} ${JSON.stringify(meta)}`;
  } catch {
    return `[${ts}] ${level.toUpperCase()} ${msg} (meta_unserializable)`;
  }
}

export function createLogger(minLevel: LogLevel = "info"): Logger {
  const min = levelRank[minLevel];

  const write = (level: LogLevel, msg: string, meta?: unknown) => {
    if (levelRank[level] < min) return;
    const line = formatLine(level, msg, meta);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };

  return {
    debug: (m, meta) => write("debug", m, meta),
    info: (m, meta) => write("info", m, meta),
    warn: (m, meta) => write("warn", m, meta),
    error: (m, meta) => write("error", m, meta)
  };
}

