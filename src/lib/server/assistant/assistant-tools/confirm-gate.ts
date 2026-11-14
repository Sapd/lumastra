// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hard two-phase confirmation gate for `create_request` (P5).
 *
 * `create_request`'s own docstring already admits the gate it had was SOFT: a
 * `confirmed:false` call followed by a `confirmed:true` call can both happen
 * inside ONE dispatch-loop invocation (the loop runs up to `maxRounds` model
 * round-trips per HTTP request), so a model steered by an injected instruction
 * in an earlier tool result could self-confirm without the user ever seeing
 * the title, let alone saying yes to it. The per-(user,title) Valkey dedupe key
 * `assistant-create-request:<userId>:<mediaId>` only defeats a PARALLEL
 * duplicate within the same round — it says nothing about whether a real user
 * turn separates the two calls.
 *
 * This module makes the gate hard: `markPendingConfirmation` records WHICH
 * invocation asked ("show me X"); `isConfirmedFromEarlierInvocation` requires
 * the invocation confirming ("yes, request X") to be a DIFFERENT one. Since
 * `dispatch.ts` mints exactly one `invocationId` per call to
 * `runAssistantToolLoop` (i.e. per HTTP request / per user turn) and threads
 * it onto every tool's `ctx`, two calls inside the SAME loop invocation — no
 * matter which round each lands in — carry the SAME invocationId and are
 * therefore refused, even though round>1 write-tool refusal (dispatch.ts)
 * would usually already have caught a same-turn confirmed:true call on its
 * own. A genuine two-turn flow (turn 1 shows the title, the user says yes,
 * turn 2 confirms) uses two DIFFERENT invocationIds and passes.
 *
 * `invocationId` is optional on `AssistantToolContext` — present on every real
 * request (dispatch.ts always sets it before calling `tool.execute`), absent
 * only when a test calls a tool's `execute()` directly, bypassing the loop
 * entirely. Both functions treat that as "the gate does not apply here": there
 * is no round/turn concept to check without a real invocation, and the many
 * existing tool-level unit tests exercise `confirmed:true` this way.
 */

import { cacheGet, setEx, isCoordinationValkeyReady } from '$lib/server/cache/valkey.js';

/**
 * Long enough to span "show me the title" → user reads it → "yes" → the next
 * turn's `confirmed:true` call, short enough that a stale marker from an
 * abandoned conversation doesn't linger and confirm an unrelated later ask.
 */
const CONFIRM_TTL_SECONDS = 300;

function confirmKey(userId: string, mediaId: string): string {
    return `assistant-confirm:${userId}:${mediaId}`;
}

/**
 * Record that `invocationId` is the one that showed this title to the user
 * (a `confirmed:false` call). Best-effort: a Valkey outage here just means the
 * marker never gets set, and `isConfirmedFromEarlierInvocation` below already
 * fails CLOSED (refuses) when it can't read one — so an outage can never
 * relax the gate, only make a legitimate confirm harder, which is the safe
 * direction to fail in.
 */
export async function markPendingConfirmation(
    userId: string,
    mediaId: string,
    invocationId: string | undefined,
): Promise<void> {
    if (!invocationId) return;
    if (!isCoordinationValkeyReady()) return;
    await setEx(confirmKey(userId, mediaId), CONFIRM_TTL_SECONDS, invocationId);
}

/**
 * True iff a `confirmed:false` call for this exact (user, title) was recorded
 * by a DIFFERENT invocation than the one asking `confirmed:true` right now —
 * i.e. a real, later user turn separates them. False (refuse) when no marker
 * was found (never shown, or it expired), when Valkey cannot be reached
 * (fail CLOSED — cannot verify), or when the marker's invocationId matches the
 * current one (same turn, same loop invocation — the exact self-confirm this
 * gate exists to stop).
 */
export async function isConfirmedFromEarlierInvocation(
    userId: string,
    mediaId: string,
    invocationId: string | undefined,
): Promise<boolean> {
    if (!invocationId) return true;
    if (!isCoordinationValkeyReady()) return false;
    const stored = await cacheGet(confirmKey(userId, mediaId));
    return stored !== null && stored !== invocationId;
}
