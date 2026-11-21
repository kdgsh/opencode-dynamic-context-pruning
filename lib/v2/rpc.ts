import { tool } from "@opencode-ai/plugin"

const z = tool.schema
const session = z.object({ sessionID: z.string() })
const stats = z.object({
    sessionTokens: z.number(),
    sessionSummaryTokens: z.number(),
    sessionDurationMs: z.number(),
    sessionTools: z.number(),
    sessionMessages: z.number(),
    allTime: z.object({
        totalTokens: z.number(),
        totalTools: z.number(),
        totalMessages: z.number(),
        sessionCount: z.number(),
    }),
})
const context = z.object({
    system: z.number(),
    user: z.number(),
    assistant: z.number(),
    tools: z.number(),
    toolCount: z.number(),
    toolsInContextCount: z.number(),
    prunedTokens: z.number(),
    prunedToolCount: z.number(),
    prunedMessageCount: z.number(),
    total: z.number(),
})
const progress = z.object({
    bar: z.string(),
    segments: z
        .array(
            z.object({
                state: z.enum(["active", "pruned", "recent"]),
                count: z.number(),
            }),
        )
        .optional(),
    compressed: z.number(),
    total: z.number(),
    blockId: z.number().optional(),
})

export const rpc = {
    id: "dcp",
    methods: {
        status: { input: z.object({}), output: z.object({ enabled: z.boolean() }) },
        // Lightweight payload for the sidebar: same context/progress fields as
        // snapshot, without the all-time stats scan or dialog-only fields.
        sidebar: {
            input: session,
            output: z.object({
                manualMode: z.boolean(),
                canCompress: z.boolean(),
                blockedReason: z.string().optional(),
                contextLimit: z.number().optional(),
                context,
                progress,
            }),
        },
        snapshot: {
            input: session,
            output: z.object({
                manualMode: z.boolean(),
                canCompress: z.boolean(),
                blockedReason: z.string().optional(),
                contextLimit: z.number().optional(),
                context,
                stats,
                progress,
            }),
        },
        manual: { input: session.extend({ enabled: z.boolean() }), output: z.object({}) },
    },
    // Server -> TUI notifications (prune/compress reports, command output).
    // Ephemeral by design: nothing is stored, nothing enters model context.
    events: {
        notify: {
            schema: z.object({
                title: z.string(),
                message: z.string(),
                variant: z.enum(["info", "success", "warning", "error"]).optional(),
                duration: z.number().optional(),
            }),
        },
        refresh: {
            schema: z.object({
                sessionID: z.string(),
            }),
        },
    },
} as const
