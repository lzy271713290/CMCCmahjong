import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type LogValue = string | number | boolean | null | undefined;
type LogFields = Record<string, LogValue>;

export const instanceId = randomUUID().slice(0, 8);

const logDirectory = process.env.LOG_DIR ?? join(process.cwd(), "logs");
const logFile = join(logDirectory, "server.jsonl");
let fileLoggingAvailable = true;

try {
  mkdirSync(logDirectory, { recursive: true });
} catch (error) {
  fileLoggingAvailable = false;
  console.error("无法创建日志目录", error);
}

function write(level: "info" | "warn" | "error", event: string, fields: LogFields = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    instanceId,
    pid: process.pid,
    ...fields,
  };
  const line = JSON.stringify(entry);
  console.log(line);
  if (!fileLoggingAvailable) return;
  try {
    appendFileSync(logFile, `${line}\n`, "utf8");
  } catch (error) {
    fileLoggingAvailable = false;
    console.error("无法写入日志文件", error);
  }
}

export const logInfo = (event: string, fields?: LogFields): void => write("info", event, fields);
export const logWarn = (event: string, fields?: LogFields): void => write("warn", event, fields);
export const logError = (event: string, fields?: LogFields): void => write("error", event, fields);

export function shortId(value: string): string {
  return value.slice(0, 8);
}
