# @rizzmo/tokochi-collectors

Open-source collectors for local AI coding token usage. The package reads local metadata produced by Codex, Claude Code, and GitHub Copilot and returns normalized token usage events.

```bash
npm install @rizzmo/tokochi-collectors
```

```ts
import { collectUsageEvents } from "@rizzmo/tokochi-collectors";

const events = await collectUsageEvents();
console.log(events);
```

## What It Reads

- Codex: `~/.codex/logs_2.sqlite`
- Claude Code: `~/.claude/projects`
- GitHub Copilot: `~/.copilot/session-state`

You can also call the individual readers with explicit paths:

```ts
import { readClaudeEvents } from "@rizzmo/tokochi-collectors";

const events = await readClaudeEvents("/path/to/.claude/projects");
```

## Event Shape

```ts
type UsageEvent = {
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
```

## Privacy

The collectors return event IDs, timestamps, agent/model names, and token counts only. Prompt text, response text, and transcript content are not returned by this package.

Tokochi CLI upload/auth behavior lives in `@rizzmo/tokochi-cli`; this package only reads and normalizes local token metadata.
