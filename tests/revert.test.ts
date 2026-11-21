import assert from "node:assert/strict"
import "./lab/persistence-env"
import test from "node:test"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    type CompressionBlock,
    type SessionState,
    type WithParts,
} from "../lib/state"
import {
    clearRevertSuspensions,
    commitRevertSuspensions,
    reconcileRevertState,
    suspendRevertedBlocks,
} from "../lib/messages/revert"
import { syncCompressionBlocks } from "../lib/messages/sync"

function msg(id: string, role: "user" | "assistant" = "user", created = 1): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "ses-revert-test",
            time: { created },
        },
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "ses-revert-test",
                type: "text" as const,
                text: `content of ${id}`,
            },
        ],
    } as unknown as WithParts
}

function buildBlock(
    blockId: number,
    anchorMessageId: string,
    compressMessageId: string,
    rangeMessageIds: string[],
    createdAt = 100,
): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: rangeMessageIds.length * 10,
        summaryTokens: 5,
        durationMs: 0,
        mode: "range",
        topic: "revert-test",
        batchTopic: "revert-test",
        startId: "m0001",
        endId: "m0009",
        anchorMessageId,
        compressMessageId,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: rangeMessageIds,
        directToolIds: [],
        effectiveMessageIds: rangeMessageIds,
        effectiveToolIds: [],
        createdAt,
        summary: "[Compressed conversation section]\nsummary",
    }
}

function activateBlock(state: SessionState, block: CompressionBlock, tokens = 10): void {
    state.prune.messages.blocksById.set(block.blockId, block)
    state.prune.messages.activeBlockIds.add(block.blockId)
    state.prune.messages.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId)
    for (const messageId of block.effectiveMessageIds) {
        state.prune.messages.byMessageId.set(messageId, {
            tokenCount: tokens,
            allBlockIds: [block.blockId],
            activeBlockIds: [block.blockId],
        })
    }
}

function setup(): {
    state: SessionState
    logger: Logger
    messages: WithParts[]
    block: CompressionBlock
} {
    const state = createSessionState()
    const logger = new Logger(false)
    const messages = [
        msg("anchor", "user", 10),
        msg("range-1", "user", 20),
        msg("range-2", "assistant", 30),
        msg("undo-boundary", "user", 40),
        msg("compress-origin", "assistant", 50),
        msg("later", "user", 60),
    ]
    const block = buildBlock(1, "anchor", "compress-origin", ["range-1", "range-2"], 60)
    activateBlock(state, block)
    state.stats.totalPruneTokens = 20
    return { state, logger, messages, block }
}

test("staging a revert restores blocks created in the reverted tail", () => {
    const { state, logger, messages, block } = setup()

    const change = suspendRevertedBlocks(state, logger, messages, "undo-boundary")

    assert.equal(change.changed, true)
    assert.deepEqual(change.blockIds, [1])
    assert.equal(block.revertSuspended, true)
    assert.equal(block.active, false)
    assert.equal(state.prune.messages.activeBlockIds.size, 0)
    assert.equal(state.prune.messages.byMessageId.get("range-1")?.activeBlockIds.length, 0)
    assert.equal(state.stats.totalPruneTokens, 0)
})

test("staging a revert leaves compressions created before the boundary active", () => {
    const { state, logger, messages, block } = setup()

    const change = suspendRevertedBlocks(state, logger, messages, "later")

    assert.equal(change.changed, false)
    assert.equal(block.revertSuspended, undefined)
    assert.equal(block.active, true)
    assert.equal(state.prune.messages.activeBlockIds.has(1), true)
    assert.equal(state.stats.totalPruneTokens, 20)
})

test("clearing a revert recompresses the restored messages", () => {
    const { state, logger, messages, block } = setup()
    suspendRevertedBlocks(state, logger, messages, "undo-boundary")
    assert.equal(state.stats.totalPruneTokens, 0)

    const change = clearRevertSuspensions(state, logger, messages)

    assert.equal(change.changed, true)
    assert.equal(block.revertSuspended, false)
    assert.equal(block.active, true)
    assert.equal(state.prune.messages.activeBlockIds.has(1), true)
    assert.equal(state.prune.messages.byMessageId.get("range-1")?.activeBlockIds.length, 1)
    assert.equal(state.stats.totalPruneTokens, 20)
})

test("committing a revert keeps the block permanently inactive even with its anchor present", () => {
    const { state, logger, messages, block } = setup()
    suspendRevertedBlocks(state, logger, messages, "undo-boundary")

    const change = commitRevertSuspensions(state, logger, messages)
    assert.equal(change.changed, true)
    assert.equal(block.deactivatedByRevert, true)
    assert.equal(block.active, false)

    // Simulate the next turn: the origin message is gone but the anchor remains.
    const afterUndo = messages.filter((message) => message.info.id !== "compress-origin")
    syncCompressionBlocks(state, logger, afterUndo)
    assert.equal(block.active, false)
    assert.equal(state.prune.messages.activeBlockIds.has(1), false)
})

test("committing a revert reactivates a compression consumed by the undone block", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const messages = [
        msg("anchor-a", "user", 10),
        msg("a-1", "user", 20),
        msg("anchor-b", "user", 30),
        msg("b-1", "user", 40),
        msg("undo-boundary", "user", 50),
        msg("compress-origin", "assistant", 60),
    ]
    const older = buildBlock(1, "anchor-a", "old-origin", ["a-1"], 10)
    activateBlock(state, older, 7)
    const newer = buildBlock(2, "anchor-b", "compress-origin", ["b-1"], 70)
    newer.consumedBlockIds = [1]
    newer.effectiveMessageIds = ["a-1", "b-1"]
    activateBlock(state, newer, 7)
    older.active = false
    state.prune.messages.activeBlockIds.delete(1)
    state.prune.messages.activeByAnchorMessageId.delete("anchor-a")
    state.prune.messages.byMessageId.set("a-1", {
        tokenCount: 7,
        allBlockIds: [1, 2],
        activeBlockIds: [2],
    })
    state.stats.totalPruneTokens = 14

    suspendRevertedBlocks(state, logger, messages, "undo-boundary")

    assert.equal(older.active, true)
    assert.equal(state.prune.messages.activeBlockIds.has(1), true)
    assert.equal(state.prune.messages.byMessageId.get("a-1")?.activeBlockIds[0], 1)
    assert.equal(newer.active, false)
})

test("moving the revert boundary forward recompresses blocks no longer in the tail", () => {
    const { state, logger, messages, block } = setup()
    suspendRevertedBlocks(state, logger, messages, "undo-boundary")
    assert.equal(block.revertSuspended, true)

    const change = suspendRevertedBlocks(state, logger, messages, "later")

    assert.equal(change.changed, true)
    assert.equal(block.revertSuspended, false)
    assert.equal(block.active, true)
    assert.equal(state.stats.totalPruneTokens, 20)
})

test("reconcile restores a suspension after a missed clear event", () => {
    const { state, logger, messages, block } = setup()
    suspendRevertedBlocks(state, logger, messages, "undo-boundary")

    const change = reconcileRevertState(state, logger, messages, undefined)

    assert.equal(change.changed, true)
    assert.equal(block.revertSuspended, false)
    assert.equal(block.active, true)
})

test("reconcile finalizes a suspension after a missed commit event", () => {
    const { state, logger, messages, block } = setup()
    suspendRevertedBlocks(state, logger, messages, "undo-boundary")
    const afterUndo = messages.filter((message) => message.info.id !== "compress-origin")

    const change = reconcileRevertState(state, logger, afterUndo, undefined)

    assert.equal(change.changed, true)
    assert.equal(block.deactivatedByRevert, true)
    assert.equal(block.active, false)
})

test("reconcile clears and commits separate suspensions in one pass", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const messages = [
        msg("anchor-a", "user", 10),
        msg("a-1", "user", 20),
        msg("anchor-b", "user", 30),
        msg("b-1", "user", 40),
        msg("origin-a", "assistant", 50),
    ]
    const cleared = buildBlock(1, "anchor-a", "origin-a", ["a-1"], 60)
    activateBlock(state, cleared, 7)
    const committed = buildBlock(2, "anchor-b", "origin-b", ["b-1"], 70)
    activateBlock(state, committed, 7)
    state.stats.totalPruneTokens = 14

    // Stage at the first message so both blocks are suspended. origin-a is
    // still present; origin-b is gone, so one clears and one commits.
    suspendRevertedBlocks(state, logger, messages, "anchor-a")
    assert.equal(cleared.revertSuspended, true)
    assert.equal(committed.revertSuspended, true)

    const change = reconcileRevertState(state, logger, messages, undefined)

    assert.equal(change.changed, true)
    assert.equal(cleared.revertSuspended, false)
    assert.equal(cleared.active, true)
    assert.equal(committed.deactivatedByRevert, true)
    assert.equal(committed.active, false)
})
