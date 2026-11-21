import type { CompressionBlock, SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import { syncCompressionBlocks } from "./sync"

export interface RevertChange {
    changed: boolean
    blockIds: number[]
    /** Positive when messages became compressed again, negative when they were restored. */
    tokenDelta: number
}

function activeTokens(state: SessionState): Map<string, number> {
    const active = new Map<string, number>()
    for (const [messageId, entry] of state.prune.messages.byMessageId) {
        if (entry.activeBlockIds.length > 0) {
            active.set(messageId, entry.tokenCount)
        }
    }
    return active
}

function adjustStats(
    state: SessionState,
    before: Map<string, number>,
    after: Map<string, number>,
    blocks: CompressionBlock[],
): number {
    const relevant = new Set<string>()
    for (const block of blocks) {
        for (const messageId of block.effectiveMessageIds) {
            relevant.add(messageId)
        }
    }

    let delta = 0
    for (const messageId of relevant) {
        const wasActive = before.has(messageId)
        const isActive = after.has(messageId)
        if (wasActive && !isActive) {
            delta -= before.get(messageId) ?? 0
        } else if (!wasActive && isActive) {
            delta += after.get(messageId) ?? 0
        }
    }

    if (delta !== 0) {
        state.stats.totalPruneTokens = Math.max(0, state.stats.totalPruneTokens + delta)
    }
    return delta
}

function finish(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    blocks: CompressionBlock[],
    changed: boolean,
): RevertChange {
    if (!changed) {
        return { changed: false, blockIds: [], tokenDelta: 0 }
    }

    const before = activeTokens(state)
    syncCompressionBlocks(state, logger, messages)
    const after = activeTokens(state)
    const tokenDelta = adjustStats(state, before, after, blocks)
    logger.info("Adjusted compression blocks for revert", {
        blockIds: blocks.map((block) => block.blockId),
        tokenDelta,
    })

    return {
        changed: true,
        blockIds: blocks.map((block) => block.blockId),
        tokenDelta,
    }
}

function boundaryDecision(
    block: CompressionBlock,
    messageIndexById: Map<string, number>,
    boundaryIndex: number,
    boundaryCreated: number | undefined,
): boolean | undefined {
    const originIndex = messageIndexById.get(block.compressMessageId)

    if (originIndex !== undefined && boundaryIndex >= 0) {
        return originIndex >= boundaryIndex
    }

    // The boundary or origin can fall outside the current context after a
    // compaction. Wall-clock creation time still orders the compression after
    // the message that started the undone turn.
    if (boundaryCreated !== undefined) {
        return block.createdAt >= boundaryCreated
    }

    return undefined
}

/**
 * Align compression blocks with the session's staged revert boundary.
 *
 * Blocks whose origin message belongs to the reverted tail are suspended so
 * their summaries and hidden ranges return to the model context. Blocks that
 * stop matching an earlier boundary are restored, which keeps repeated
 * `session.revert.stage` calls idempotent.
 */
export function suspendRevertedBlocks(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    boundaryMessageId: string,
): RevertChange {
    const messageIndexById = new Map<string, number>()
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index]
        if (message) {
            messageIndexById.set(message.info.id, index)
        }
    }

    const boundaryIndex = messageIndexById.get(boundaryMessageId) ?? -1
    const boundaryCreated =
        boundaryIndex >= 0 ? messages[boundaryIndex]?.info.time.created : undefined
    const now = Date.now()
    const touched: CompressionBlock[] = []
    let changed = false

    for (const block of state.prune.messages.blocksById.values()) {
        if (block.deactivatedByUser || block.deactivatedByRevert) {
            continue
        }

        const decision = boundaryDecision(block, messageIndexById, boundaryIndex, boundaryCreated)
        if (decision === undefined) {
            continue
        }

        if (decision) {
            if (!block.revertSuspended) {
                block.revertSuspended = true
                changed = true
            }
            if (block.active) {
                block.active = false
                block.deactivatedAt = now
                block.deactivatedByBlockId = undefined
                changed = true
            }
            touched.push(block)
        } else if (block.revertSuspended) {
            block.revertSuspended = false
            block.deactivatedAt = undefined
            block.deactivatedByBlockId = undefined
            touched.push(block)
            changed = true
        }
    }

    return finish(state, logger, messages, touched, changed)
}

/**
 * Restore blocks suspended by a staged revert. Called when the user clears the
 * revert (`redo`), or when a missed clear event is detected on load.
 */
export function clearRevertSuspensions(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    onlyBlockIds?: ReadonlySet<number>,
): RevertChange {
    const touched: CompressionBlock[] = []
    let changed = false

    for (const block of state.prune.messages.blocksById.values()) {
        if (!block.revertSuspended) {
            continue
        }
        if (onlyBlockIds && !onlyBlockIds.has(block.blockId)) {
            continue
        }
        block.revertSuspended = false
        block.deactivatedAt = undefined
        block.deactivatedByBlockId = undefined
        touched.push(block)
        changed = true
    }

    return finish(state, logger, messages, touched, changed)
}

/**
 * Keep suspended blocks disabled after the revert is committed. The messages
 * and the compressing assistant message are gone, so these blocks must never
 * become active again even though their anchors may still be present.
 */
export function commitRevertSuspensions(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    onlyBlockIds?: ReadonlySet<number>,
): RevertChange {
    const touched: CompressionBlock[] = []
    let changed = false
    const now = Date.now()

    for (const block of state.prune.messages.blocksById.values()) {
        if (!block.revertSuspended) {
            continue
        }
        if (onlyBlockIds && !onlyBlockIds.has(block.blockId)) {
            continue
        }
        block.revertSuspended = false
        block.deactivatedByRevert = true
        block.active = false
        block.deactivatedAt = block.deactivatedAt ?? now
        block.deactivatedByBlockId = undefined
        touched.push(block)
        changed = true
    }

    return finish(state, logger, messages, touched, changed)
}

/**
 * Reconcile persisted state with a session that may have changed while the
 * plugin or server was not observing revert events.
 */
export function reconcileRevertState(
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
    boundaryMessageId: string | undefined,
): RevertChange {
    if (boundaryMessageId) {
        return suspendRevertedBlocks(state, logger, messages, boundaryMessageId)
    }

    const messageIds = new Set(messages.map((message) => message.info.id))
    const touched: CompressionBlock[] = []
    const now = Date.now()
    let changed = false

    // Decide clear-vs-commit for every suspension in one pass, then sync once.
    for (const block of state.prune.messages.blocksById.values()) {
        if (!block.revertSuspended) {
            continue
        }

        block.revertSuspended = false
        block.deactivatedByBlockId = undefined
        if (messageIds.has(block.compressMessageId)) {
            block.deactivatedAt = undefined
        } else {
            block.deactivatedByRevert = true
            block.active = false
            block.deactivatedAt = block.deactivatedAt ?? now
        }
        touched.push(block)
        changed = true
    }

    return finish(state, logger, messages, touched, changed)
}
