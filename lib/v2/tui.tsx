/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal } from "solid-js"
import { ContextDialog, PanelDialog, StatsDialog, StatusDialog } from "../tui/dialogs"
import type { ViewApi } from "../tui/types"
import { rpc } from "./rpc"
import { panelTheme } from "./theme"

export async function setup(ctx: Plugin.Context) {
    const client = ctx.client.rpc(rpc)
    const options = () => ({ location: ctx.location ?? ctx.data.location.default() })
    if (!(await client.status({}, options())).enabled) return

    const [progressTick, setProgressTick] = createSignal(0)
    if (typeof ctx.data?.on === "function") {
        ctx.data.on("rpc.dcp.notify", () => setProgressTick((value) => value + 1))
    }

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
        activeBlocks: number
        blockId?: number
    }

    function SidebarProgress(props: { sessionID: string }) {
        const [value, setValue] = createSignal<ProgressView | null>(null)
        createEffect(() => {
            const sessionID = props.sessionID
            progressTick()
            void client
                .progress({ sessionID }, options())
                .then(setValue)
                .catch(() => setValue(null))
        })
        const data = value()
        if (!data) return null
        return (
            <box flexDirection="row" gap={1}>
                <text fg={api.theme.current.accent}>DCP</text>
                <text fg={api.theme.current.text}>{data.bar}</text>
                {data.blockId ? (
                    <text fg={api.theme.current.textMuted}>b{data.blockId}</text>
                ) : null}
                <text fg={api.theme.current.textMuted}>
                    {data.compressed}/{data.total}
                </text>
            </box>
        )
    }

    ctx.ui.slot({
        append: "sidebar.footer",
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
}
