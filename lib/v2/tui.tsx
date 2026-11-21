/** @jsxImportSource @opentui/solid */
import type { BoxRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { ContextDialog, PanelDialog, StatsDialog, StatusDialog } from "../tui/dialogs"
import type { ViewApi } from "../tui/types"
import { rpc } from "./rpc"
import { panelTheme } from "./theme"

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
        compressed: number
        total: number
        blockId?: number
        loaded: boolean
        error: string
        width: number
    }

    const [progress, setProgress] = ctx.storage.memory("dcp.progress", {
        initial: {
            bar: "│░░░░░░░░░░░░░░│",
            compressed: 0,
            total: 0,
            blockId: undefined as number | undefined,
            loaded: false as boolean,
            error: "",
            width: 24,
        } satisfies ProgressView,
    })
    let activeSession: string | undefined
    let refreshing = false

    const refresh = async () => {
        if (!activeSession || refreshing) return
        refreshing = true
        try {
            const next = await client.snapshot({ sessionID: activeSession }, options())
            setProgress((draft) => {
                draft.bar = next.progress.bar
                draft.compressed = next.progress.compressed
                draft.total = next.progress.total
                draft.blockId = next.progress.blockId
                draft.loaded = true
                draft.error = ""
            })
        } catch (cause) {
            setProgress((draft) => {
                draft.loaded = true
                draft.error = cause instanceof Error ? cause.message : String(cause)
            })
        } finally {
            refreshing = false
        }
    }

    if (typeof ctx.data?.on === "function") {
        ctx.data.on("rpc.dcp.notify", () => {
            void refresh()
        })
    }

    function fitBar(bar: string, width: number): string {
        const inner = bar.replace(/^│|│$/g, "")
        const cells = Math.max(8, width)
        if (!inner) return `│${"░".repeat(cells)}│`
        const fitted = Array.from({ length: cells }, (_, index) => {
            const source = Math.floor((index * inner.length) / cells)
            return inner[source] ?? "░"
        })
        return `│${fitted.join("")}│`
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
                void refresh()
            })
        }
        const status = progress.loaded ? `${progress.compressed}/${progress.total}` : "loading"
        return (
            <box
                ref={(r: BoxRenderable) => {
                    barBox = r
                    updateWidth()
                }}
                onSizeChange={updateWidth}
                flexDirection="column"
                gap={0}
                paddingTop={1}
                width="100%"
            >
                <text fg={api.theme.current.text}>{fitBar(progress.bar, progress.width)}</text>
                <text fg={api.theme.current.textMuted}>
                    {progress.blockId ? `b${progress.blockId} · ` : ""}
                    {status}
                </text>
                {progress.error ? <text fg={api.theme.current.error}>{progress.error}</text> : null}
            </box>
        )
    }

    ctx.ui.slot({
        append: "sidebar.content",
        render(input) {
            return <SidebarProgress sessionID={input.sessionID} />
        },
    })
    const progressTimer = setInterval(() => {
        void refresh()
    }, 10000)

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
            const data = await client.snapshot({ sessionID }, options())
            const back = () => {
                void open()
            }
            if (page === "context")
                show(() => <ContextDialog api={api} breakdown={data.context} onBack={back} />)
            else if (page === "stats")
                show(() => <StatsDialog api={api} report={data.stats} onBack={back} />)
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
    return () => clearInterval(progressTimer)
}
