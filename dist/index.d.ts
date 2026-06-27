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
export declare function collectUsageEvents(): Promise<UsageEvent[]>;
export declare function readCodexEvents(path: string): Promise<UsageEvent[]>;
export declare function readClaudeEvents(path: string): Promise<UsageEvent[]>;
export declare function readCopilotEvents(path: string): Promise<UsageEvent[]>;
export declare function extractJsonAfterMarker(body: string, marker: string): Record<string, unknown> | null;
