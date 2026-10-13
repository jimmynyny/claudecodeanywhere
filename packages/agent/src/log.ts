type Level = 'info' | 'warn' | 'error';

export function log(level: Level, msg: string, extra?: unknown): void {
  const suffix = extra === undefined ? '' : ' ' + stringify(extra);
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${suffix}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
