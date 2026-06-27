import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type UsageEvent = {
  source: "codex" | "claude" | "copilot";
  event_id: string;
  timestamp: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  reasoning_tokens: number;
};

export async function collectUsageEvents(): Promise<UsageEvent[]> {
  const [codex, claude, copilot] = await Promise.all([
    readCodexEvents(process.env.TOKOCHI_CODEX_LOGS_PATH ?? join(homedir(), ".codex", "logs_2.sqlite")),
    readClaudeEvents(process.env.TOKOCHI_CLAUDE_PROJECTS_PATH ?? join(homedir(), ".claude", "projects")),
    readCopilotEvents(process.env.TOKOCHI_COPILOT_SESSION_PATH ?? join(homedir(), ".copilot", "session-state")),
  ]);
  return [...codex, ...claude, ...copilot];
}

export async function readCodexEvents(path: string): Promise<UsageEvent[]> {
  if (!(await exists(path))) return [];
  const events = new Map<string, UsageEvent>();
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const rows = database.prepare(`
      select ts, feedback_log_body
      from logs
      where feedback_log_body like '%response.completed%'
        and feedback_log_body like '%"usage"%'
      order by ts asc
    `).all() as { ts: number; feedback_log_body: string }[];
    for (const [index, row] of rows.entries()) {
      const payload =
        extractJsonAfterMarker(row.feedback_log_body, "websocket event: ") ??
        extractJsonAfterMarker(row.feedback_log_body, "Received message ");
      if (payload?.type !== "response.completed" || !isRecord(payload.response)) continue;
      const response = payload.response;
      if (!isRecord(response.usage)) continue;
      const eventId = text(response.id) || `codex:${row.ts}:${index}`;
      if (events.has(eventId)) continue;
      events.set(eventId, eventFromUsage(
        "codex",
        eventId,
        timestampFrom(response.completed_at ?? response.created_at ?? row.ts),
        text(response.model) || "unknown",
        response.usage,
      ));
    }
  } catch {
    return [];
  } finally {
    database?.close();
  }
  return [...events.values()];
}

export async function readClaudeEvents(path: string): Promise<UsageEvent[]> {
  const files = await jsonlFiles(path, (name) => name.endsWith(".jsonl"));
  const events = new Map<string, UsageEvent>();
  for (const file of files) {
    for (const [index, record] of (await records(file)).entries()) {
      if (!isRecord(record.message) || record.message.role !== "assistant" || !isRecord(record.message.usage)) continue;
      const eventId = text(record.message.id) || text(record.uuid) || `${file}:${index}`;
      if (events.has(eventId)) continue;
      const timestamp = timestampFrom(record.timestamp);
      if (!timestamp) continue;
      events.set(eventId, eventFromUsage(
        "claude",
        eventId,
        timestamp,
        text(record.message.model) || text(record.model) || "unknown",
        record.message.usage,
      ));
    }
  }
  return [...events.values()];
}

export async function readCopilotEvents(path: string): Promise<UsageEvent[]> {
  const files = await jsonlFiles(path, (name) => name === "events.jsonl");
  const events = new Map<string, UsageEvent>();
  for (const file of files) {
    for (const [index, record] of (await records(file)).entries()) {
      if (record.type !== "session.shutdown" || !isRecord(record.data) || !isRecord(record.data.modelMetrics)) continue;
      const timestamp = timestampFrom(record.timestamp);
      if (!timestamp) continue;
      const rootId = text(record.id) || `${file}:${index}`;
      for (const [model, metrics] of Object.entries(record.data.modelMetrics)) {
        if (!isRecord(metrics) || !isRecord(metrics.usage)) continue;
        const eventId = `${rootId}:${model}`;
        if (events.has(eventId)) continue;
        events.set(eventId, {
          source: "copilot",
          event_id: eventId,
          timestamp,
          model,
          input_tokens: token(metrics.usage.inputTokens),
          output_tokens: token(metrics.usage.outputTokens),
          cache_creation_input_tokens: token(metrics.usage.cacheWriteTokens),
          cache_read_input_tokens: token(metrics.usage.cacheReadTokens),
          reasoning_tokens: token(metrics.usage.reasoningTokens),
        });
      }
    }
  }
  return [...events.values()];
}

export function extractJsonAfterMarker(body: string, marker: string): Record<string, unknown> | null {
  const index = body.indexOf(marker);
  if (index < 0) return null;
  try {
    const value = JSON.parse(body.slice(index + marker.length).trim());
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function eventFromUsage(
  source: UsageEvent["source"],
  eventId: string,
  timestamp: string | null,
  model: string,
  usage: Record<string, unknown>,
): UsageEvent {
  return {
    source,
    event_id: eventId,
    timestamp: timestamp ?? new Date(0).toISOString(),
    model,
    input_tokens: token(usage.input_tokens),
    output_tokens: token(usage.output_tokens),
    cache_creation_input_tokens: token(usage.cache_creation_input_tokens),
    cache_read_input_tokens: token(usage.cache_read_input_tokens),
    reasoning_tokens: token(usage.reasoning_tokens),
  };
}

function token(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function timestampFrom(value: unknown): string | null {
  const date = typeof value === "number" ? new Date(value * 1000) : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf()) ? date.toISOString() : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function records(path: string): Promise<Record<string, unknown>[]> {
  try {
    return (await readFile(path, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line);
          return isRecord(value) ? [value] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function jsonlFiles(path: string, include: (name: string) => boolean): Promise<string[]> {
  if (!(await exists(path))) return [];
  if ((await stat(path)).isFile()) return [path];
  const found: string[] = [];
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) found.push(...await jsonlFiles(child, include));
    else if (entry.isFile() && include(entry.name)) found.push(child);
  }
  return found.sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
