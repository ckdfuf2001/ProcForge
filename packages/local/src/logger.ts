// stdout은 MCP 전용. 로깅은 stderr로만 (M2.5-8).
function line(level: string, msg: string, extra?: unknown): void {
  const tail = extra === undefined ? "" : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  process.stderr.write(`${new Date().toISOString()} [procforge:${level}] ${msg}${tail}\n`);
}

export const logger = {
  info: (msg: string, extra?: unknown) => line("info", msg, extra),
  warn: (msg: string, extra?: unknown) => line("warn", msg, extra),
  error: (msg: string, extra?: unknown) => line("error", msg, extra),
};
