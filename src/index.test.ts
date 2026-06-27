import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractJsonAfterMarker,
  readClaudeEvents,
  readCodexEvents,
  readCopilotEvents,
} from "./index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }));
  }
});

describe("collector helpers", () => {
  it("extracts a Codex websocket payload", () => {
    const payload = { type: "response.completed", response: { id: "resp_1" } };
    expect(extractJsonAfterMarker(`prefix websocket event: ${JSON.stringify(payload)}`, "websocket event: ")).toEqual(payload);
  });

  it("ignores malformed payloads", () => {
    expect(extractJsonAfterMarker("websocket event: nope", "websocket event: ")).toBeNull();
  });
});

describe("Codex events", () => {
  it("extracts response.completed usage rows", async () => {
    const dir = await tempDir();
    const databasePath = join(dir, "logs_2.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("create table logs (ts integer, feedback_log_body text)");
    const payload = {
      type: "response.completed",
      response: {
        id: "resp_1",
        completed_at: 1_720_000_000,
        model: "gpt-test",
        usage: {
          input_tokens: 10.9,
          output_tokens: 4,
          cache_creation_input_tokens: -2,
          cache_read_input_tokens: "5",
          reasoning_tokens: 3,
        },
      },
    };
    database.prepare("insert into logs values (?, ?)").run(1_720_000_001, `websocket event: ${JSON.stringify(payload)}`);
    database.close();

    await expect(readCodexEvents(databasePath)).resolves.toEqual([{
      source: "codex",
      event_id: "resp_1",
      timestamp: "2024-07-03T09:46:40.000Z",
      model: "gpt-test",
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      reasoning_tokens: 3,
    }]);
  });

  it("returns an empty list when the database is missing", async () => {
    await expect(readCodexEvents(join(await tempDir(), "missing.sqlite"))).resolves.toEqual([]);
  });
});

describe("Claude events", () => {
  it("extracts assistant message usage and dedupes event IDs", async () => {
    const dir = await tempDir();
    const project = join(dir, "project");
    await mkdir(project, { recursive: true });
    const event = {
      timestamp: "2025-01-02T03:04:05.000Z",
      message: {
        role: "assistant",
        id: "msg_1",
        model: "claude-test",
        usage: {
          input_tokens: 7,
          output_tokens: 8,
          cache_creation_input_tokens: 9,
          cache_read_input_tokens: 10,
          reasoning_tokens: 11,
        },
      },
    };
    await writeFile(join(project, "conversation.jsonl"), [
      JSON.stringify({ message: { role: "user", usage: { input_tokens: 99 } } }),
      JSON.stringify(event),
      JSON.stringify(event),
      "not json",
    ].join("\n"));

    await expect(readClaudeEvents(dir)).resolves.toEqual([{
      source: "claude",
      event_id: "msg_1",
      timestamp: "2025-01-02T03:04:05.000Z",
      model: "claude-test",
      input_tokens: 7,
      output_tokens: 8,
      cache_creation_input_tokens: 9,
      cache_read_input_tokens: 10,
      reasoning_tokens: 11,
    }]);
  });

  it("returns an empty list when the projects directory is missing", async () => {
    await expect(readClaudeEvents(join(await tempDir(), "missing"))).resolves.toEqual([]);
  });
});

describe("Copilot events", () => {
  it("extracts session shutdown model metrics", async () => {
    const dir = await tempDir();
    const nested = join(dir, "workspace");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "events.jsonl"), JSON.stringify({
      type: "session.shutdown",
      id: "session_1",
      timestamp: "2025-03-04T05:06:07.000Z",
      data: {
        modelMetrics: {
          "gpt-copilot": {
            usage: {
              inputTokens: 1,
              outputTokens: 2,
              cacheWriteTokens: 3,
              cacheReadTokens: 4,
              reasoningTokens: 5,
            },
          },
        },
      },
    }));

    await expect(readCopilotEvents(dir)).resolves.toEqual([{
      source: "copilot",
      event_id: "session_1:gpt-copilot",
      timestamp: "2025-03-04T05:06:07.000Z",
      model: "gpt-copilot",
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
      reasoning_tokens: 5,
    }]);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tokochi-collectors-"));
  tempDirs.push(dir);
  return dir;
}
