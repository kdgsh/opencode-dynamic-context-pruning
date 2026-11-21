/** @jsxImportSource @opentui/solid */
import type { BoxRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { createMemo } from "solid-js"
import { ContextDialog, PanelDialog, StatsDialog, StatusDialog } from "../tui/dialogs"
import type { ViewApi } from "../tui/types"
import { formatTokenCount } from "../ui/utils"
import { rpc } from "./rpc"
import { panelTheme } from "./theme"

type SegmentState = "active" | "pruned" | "recent"
type ProgressSegment = { state: SegmentState; count: number }
type BarCell = { state: SegmentState; cells: number }

const BAR_GLYPH: Record<SegmentState, string> = {
    active: "█",
    pruned: "░",
    recent: "⣿",
}

function segmentsFromBar(bar: string): ProgressSegment[] {
    const segments: ProgressSegment[] = []
    for (const char of Array.from(bar.replace(/^│|│$/g, ""))) {
        const state: SegmentState = char === "⣿" ? "recent" : char === "░" ? "pruned" : "active"
        const last = segments.at(-1)
        if (last?.state === state) last.count++
        else segments.push({ state, count: 1 })
    }
    return segments
}

function fitSegments(segments: ProgressSegment[], width: number): BarCell[] {
    const cells = Math.max(8, width)
    const total = segments.reduce((sum, segment) => sum + segment.count, 0)
    if (total <= 0) return []

    const parts = segments.map((segment, index) => {
        const exact = (segment.count / total) * cells
        const base = Math.floor(exact)
        return { state: segment.state, index, cells: base, remainder: exact - base }
    })
    let spare = cells - parts.reduce((sum, part) => sum + part.cells, 0)
    for (const part of [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
        if (spare <= 0) break
        part.cells++
        spare--
    }
    return parts.filter((part) => part.cells > 0).map(({ state, cells }) => ({ state, cells }))
}

function percentLabel(value: number, total: number): string {
    if (total <= 0) return "—"
    const percent = (value / total) * 100
    if (percent > 0 && percent < 1) return "<1%"
    return `${Math.round(percent)}%`
}

function tokenLabel(value: number): string {
    return `~${formatTokenCount(Math.max(0, value), true)}`
}

function clip(value: string, width: number): string {
    const chars = Array.from(value)
    if (chars.length <= width) return value
    return `${chars.slice(0, Math.max(1, width - 1)).join("")}…`
}

export async function setup(ctx: Plugin.Context) {
    const client = ctx.client.rpc(rpc)
    const options = () => ({ location: ctx.location ?? ctx.data.location.default() })
    if (!(await client.status({}, options())).enabled) return

    // Render server-side DCP reports as transient toasts. Events are
    // ephemeral: nothing stored, nothing in model context.
    if (typeof ctx.data?.on === "function" && typeof ctx.ui?.toast?.show === "function") {
        const TOAST_MAX_LINES = 12
        const truncateToast = (message: string): string => {
            const lines = message.split("\n")
            if (lines.length <= TOAST_MAX_LINES) return message
            const remaining = lines.length - TOAST_MAX_LINES + 1
            return lines.slice(0, TOAST_MAX_LINES - 1).join("\n") + `\n... and ${remaining} more`
        }
        ctx.data.on("rpc.dcp.notify", (event) => {
            const data = (event?.data ?? {}) as {
                title?: string
                message?: string
                variant?: "info" | "success" | "warning" | "error"
                duration?: number
            }
            if (!data.message) return
            ctx.ui.toast.show({
                title: data.title ?? "DCP",
                message: truncateToast(data.message),
                variant: data.variant ?? "info",
                duration: data.duration ?? 5000,
            })
        })
    }

    const api: ViewApi = {
        renderer: ctx.renderer,
        theme: {
            get current() {
                return panelTheme(ctx.theme)
            },
        },
        ui: { dialog: { clear: () => ctx.ui.dialog.clear() } },
    }

    type ProgressView = {
        bar: string
        segments: ProgressSegment[]
        compressed: number
        total: number
        blockId?: number
        contextTokens: number
        contextLimit: number
        savedTokens: number
        loaded: boolean
        error: string
        width: number
    }

    const [progress, setProgress] = ctx.storage.memory("dcp.sidebar.progress", {
        initial: {
            bar: "",
            segments: [] as ProgressSegment[],
            compressed: 0,
            total: 0,
            blockId: undefined as number | undefined,
            contextTokens: 0,
            contextLimit: 0,
            savedTokens: 0,
            loaded: false as boolean,
            error: "",
            width: 24,
        } satisfies ProgressView,
    })
    let activeSession: string | undefined
    let refreshing = false
    let refreshQueued = false

    const sidebarData = async (sessionID: string) => {
        try {
            return await client.sidebar({ sessionID }, options())
        } catch {
            // Older servers only expose snapshot; it carries the same fields.
            return await client.snapshot({ sessionID }, options())
        }
    }

    const refresh = async () => {
        const sessionID = activeSession
        if (!sessionID) return
        if (refreshing) {
            refreshQueued = true
            return
        }
        refreshing = true
        try {
            const next = await sidebarData(sessionID)
            if (sessionID !== activeSession) return
            setProgress((draft) => {
                draft.bar = next.progress.bar
                draft.segments = next.progress.segments ?? []
                draft.compressed = next.progress.compressed
                draft.total = next.progress.total
                draft.blockId = next.progress.blockId
                draft.contextTokens = next.context.total
                draft.contextLimit = next.contextLimit ?? 0
                draft.savedTokens = next.context.prunedTokens
                draft.loaded = true
                draft.error = ""
            })
        } catch (cause) {
            if (sessionID !== activeSession) return
            setProgress((draft) => {
                draft.loaded = true
                draft.error = cause instanceof Error ? cause.message : String(cause)
            })
        } finally {
            refreshing = false
            if (refreshQueued) {
                refreshQueued = false
                void refresh()
            }
        }
    }

    if (typeof ctx.data?.on === "function") {
        ctx.data.on("rpc.dcp.notify", () => {
            void refresh()
        })
        const refreshSession = (sessionID: string) => {
            if (sessionID === activeSession) void refresh()
        }
        ctx.data.on("session.idle", (event) => refreshSession(event.data.sessionID))
        ctx.data.on("session.compaction.ended", (event) => refreshSession(event.data.sessionID))
        // The server emits this after it has persisted a revert-driven block
        // change, so the snapshot always sees the settled state.
        ctx.data.on("rpc.dcp.refresh", (event) => {
            const data = (event?.data ?? {}) as { sessionID?: string }
            if (data.sessionID === activeSession) void refresh()
        })
    }

    let barBox: BoxRenderable | undefined
    function updateWidth() {
        const width = barBox?.width ?? 0
        if (width <= 0) return
        const cells = Math.max(8, width - 2)
        if (cells !== progress.width) {
            setProgress((draft) => {
                draft.width = cells
            })
        }
    }

    function SidebarProgress(props: { sessionID: string }) {
        if (activeSession !== props.sessionID) {
            activeSession = props.sessionID
            queueMicrotask(() => {
                setProgress((draft) => {
                    draft.loaded = false
                    draft.error = ""
                    draft.bar = ""
                    draft.segments = []
                    draft.compressed = 0
                    draft.total = 0
                    draft.blockId = undefined
                    draft.contextTokens = 0
                    draft.contextLimit = 0
                    draft.savedTokens = 0
                })
                void refresh()
            })
        }

        const theme = () => api.theme.current
        const segmentList = createMemo(() =>
            progress.segments?.length ? progress.segments : segmentsFromBar(progress.bar),
        )
        const cells = createMemo(() => fitSegments(segmentList(), progress.width))
        const barText = createMemo(() =>
            cells()
                .map((cell) => BAR_GLYPH[cell.state].repeat(cell.cells))
                .join(""),
        )
        const usage = () =>
            progress.contextLimit > 0 && progress.contextTokens > 0
                ? (progress.contextTokens / progress.contextLimit) * 100
                : undefined
        const usageColor = () => {
            const value = usage()
            if (value === undefined) return theme().textMuted
            if (value >= 90) return theme().error
            if (value >= 75) return theme().warning
            return theme().textMuted
        }

        return (
            <box flexDirection="column" gap={0} paddingTop={1} paddingBottom={1} width="100%">
                <box flexDirection="row" justifyContent="space-between" width="100%">
                    <text fg={theme().primary}>
                        <b>DCP</b>
                    </text>
                    <text fg={progress.compressed > 0 ? theme().success : theme().textMuted}>
                        <b>
                            {progress.loaded
                                ? percentLabel(progress.compressed, progress.total)
                                : "…"}
                        </b>
                    </text>
                </box>
                <box
                    ref={(r: BoxRenderable) => {
                        barBox = r
                        updateWidth()
                    }}
                    onSizeChange={updateWidth}
                    flexDirection="row"
                    width="100%"
                >
                    <text fg={theme().borderSubtle}>│</text>
                    <text fg={theme().text}>
                        {cells().length === 0 ? "░".repeat(Math.max(8, progress.width)) : barText()}
                    </text>
                    <text fg={theme().borderSubtle}>│</text>
                </box>
                <box flexDirection="row" justifyContent="space-between" width="100%">
                    <text fg={theme().textMuted}>
                        {!progress.loaded
                            ? "loading…"
                            : progress.total === 0
                              ? "no messages yet"
                              : `${progress.compressed}/${progress.total} msgs`}
                    </text>
                    {progress.savedTokens > 0 ? (
                        <text fg={theme().success}>
                            <b>saved {tokenLabel(progress.savedTokens)}</b>
                        </text>
                    ) : null}
                </box>
                <box flexDirection="row" justifyContent="space-between" width="100%">
                    <box flexDirection="row" gap={1}>
                        <text fg={theme().textMuted}>ctx</text>
                        <text fg={theme().text}>
                            {progress.contextTokens > 0 ? tokenLabel(progress.contextTokens) : "—"}
                            {progress.contextTokens > 0 && progress.contextLimit > 0
                                ? `/${formatTokenCount(progress.contextLimit, true)}`
                                : ""}
                        </text>
                        {usage() !== undefined ? (
                            <text fg={usageColor()}>
                                {percentLabel(progress.contextTokens, progress.contextLimit)}
                            </text>
                        ) : null}
                    </box>
                    {progress.blockId !== undefined ? (
                        <text fg={theme().primary}>
                            <b>blk {progress.blockId}</b>
                        </text>
                    ) : null}
                </box>
                {progress.error ? (
                    <text fg={theme().error}>
                        {clip(progress.error, Math.max(8, progress.width + 2))}
                    </text>
                ) : null}
            </box>
        )
    }

    ctx.ui.slot({
        append: "sidebar.content",
        render(input) {
            return <SidebarProgress sessionID={input.sessionID} />
        },
    })
    function show(render: Parameters<typeof ctx.ui.dialog.show>[0]) {
        ctx.ui.dialog.set({ size: "xlarge" })
        ctx.ui.dialog.show(render)
    }
    async function open(page: "panel" | "context" | "stats" = "panel") {
        const route = ctx.ui.router.current()
        if (route.type !== "session") {
            show(() => (
                <StatusDialog
                    api={api}
                    title="DCP"
                    eyebrow="No session"
                    message="Open a session first."
                />
            ))
            return
        }
        const sessionID = route.sessionID
        try {
            const back = () => {
                void open()
            }
            // Only the stats page needs the all-time scan backed by every
            // session file. The panel and context pages share the sidebar view.
            if (page === "stats") {
                const data = await client.snapshot({ sessionID }, options())
                show(() => <StatsDialog api={api} report={data.stats} onBack={back} />)
                return
            }

            const data = await sidebarData(sessionID)
            if (page === "context")
                show(() => <ContextDialog api={api} breakdown={data.context} onBack={back} />)
            else
                show(() => (
                    <PanelDialog
                        api={api}
                        manualMode={data.manualMode}
                        canCompress={data.canCompress}
                        blockedReason={data.blockedReason}
                        onContext={() => {
                            void open("context")
                        }}
                        onStats={() => {
                            void open("stats")
                        }}
                        onManual={(enabled) => {
                            void client
                                .manual({ sessionID, enabled }, options())
                                .then(back)
                                .catch(error)
                        }}
                    />
                ))
        } catch (cause) {
            error(cause)
        }
    }
    function error(cause: unknown) {
        const message =
            cause instanceof Error
                ? cause.message
                : typeof cause === "object" && cause && "message" in cause
                  ? String(cause.message)
                  : String(cause)
        show(() => <StatusDialog api={api} title="DCP" eyebrow="DCP Error" message={message} />)
    }
    ctx.ui.slot({
        append: "app",
        render() {
            ctx.keymap.layer(() => ({
                mode: "global",
                commands: [
                    {
                        id: "dcp.panel",
                        title: "DCP",
                        description: "Open DCP panel",
                        group: "DCP",
                        palette: true,
                        slash: { name: "dcp", arguments: true },
                        run: async (input) => {
                            if (!input?.trim()) return open()
                            const route = ctx.ui.router.current()
                            if (route.type !== "session") return open()
                            try {
                                await ctx.client.session.command({
                                    sessionID: route.sessionID,
                                    name: "dcp",
                                    text: input,
                                })
                            } catch (cause) {
                                error(cause)
                            }
                        },
                    },
                ],
            }))
            return null
        },
    })
}
