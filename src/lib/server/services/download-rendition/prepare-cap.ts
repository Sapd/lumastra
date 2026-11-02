// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-user cap on renditions waiting to be encoded.
 *
 * ## Why this exists
 *
 * `DOWNLOAD_RENDITION_MAX_CONCURRENT` is 1 per pod, its guard is an in-process
 * `Set`, and there is no per-user cap of any kind. A deferred `queued` row is
 * advanced by NOTHING on the server — only by a client re-POST after
 * `DOWNLOAD_RENDITION_STALE_SECONDS`. An unattended pool that POSTs fifty
 * renditions therefore gets one encode and leaves forty-nine queued while every
 * other user's manual download waits behind them. That is a user-visible
 * outage caused by a background feature.
 *
 * ## Why a Valkey SET and not a counter or a database column
 *
 * A column is not available: `requested_by` was deliberately dropped from
 * `download_renditions` by migration 16.204.0 under data minimisation, and
 * re-introducing per-user attribution at rest to enforce a rate limit would
 * undo that decision. An ephemeral TTL key re-introduces nothing at rest.
 *
 * A plain counter is not enough either. The cap must ADMIT a re-POST of a slot
 * the user already holds — that re-POST is the only thing that ever advances a
 * deferred rendition, so a counter that refused it would cause exactly the
 * stall it exists to prevent. A set of artifact identities answers "do you
 * already hold this one?" directly, and releases idempotently, which a
 * counter's increment/decrement pair does not.
 *
 * ## Fail-open, deliberately
 *
 * When Valkey is unavailable every helper degrades to "no slots held", so pool
 * requests are admitted rather than refused. A cap is a fairness measure; a
 * cache outage must not become a download outage. The global queue-depth check
 * in the endpoint reads Postgres and still applies.
 */

import { sAddBounded, sCard, sMembers, sRem, expire } from '$lib/server/cache/valkey.js';
import { config } from '$lib/server/config.js';

/**
 * Key holding one user's pending prepare set.
 *
 * The `dl:prep:` prefix MUST be listed in `COORDINATION_KEY_PREFIXES` in
 * `cache/valkey.ts`: an evicted set silently LIFTS the cap, which is the
 * dangerous direction.
 */
export function prepareSlotKey(userId: string): string {
    return `dl:prep:${userId}`;
}

/**
 * The artifact's identity — the same `(file, rung, audio track)` triple the
 * table's unique constraint uses. Keying on anything request-shaped would make
 * a re-POST of the same rendition look like a new prepare.
 */
export function prepareSlotMember(
    fileId: string,
    rungId: string,
    audioIndex: number | null,
): string {
    // `none` rather than a stringified null: the POST that holds this member and
    // the status GET that releases it must produce byte-identical strings, and a
    // spelled-out token cannot be confused with a real index or quietly changed
    // by a `?? ''` somewhere upstream.
    return `${fileId}:${rungId}:${audioIndex ?? 'none'}`;
}

/** TTL, generous enough to outlive a slow encode and short enough to self-heal. */
function slotTtlSeconds(): number {
    return Math.max(60, config.DOWNLOAD_RENDITION_STALE_SECONDS * 2);
}

export async function pendingPrepareSlots(userId: string): Promise<string[]> {
    return sMembers(prepareSlotKey(userId));
}

export async function releasePrepareSlot(userId: string, member: string): Promise<void> {
    const key = prepareSlotKey(userId);
    await sRem(key, member);
    if ((await sCard(key)) > 0) {
        await expire(key, slotTtlSeconds()).catch(() => undefined);
    }
}

/**
 * The real admission decision, and the write that enforces it, in ONE atomic
 * Valkey round trip (`sAddBounded`, a Lua script).
 *
 * A previous version of this cap split "may I?" (read the set, decide in JS)
 * from "I do" (SADD later, after paying for a probe + `requestRendition`).
 * Every concurrent request in that window reads the same pre-write snapshot,
 * so N parallel pool POSTs from one user all decide "yes" and all write —
 * the cap only takes effect once the burst has already landed. Deciding and
 * writing atomically closes that window: only ONE of N concurrent callers
 * racing on an empty set can be the SADD that pushes cardinality to 1 and
 * still passes the cap check inside the same script.
 *
 * Admits unconditionally when the user already holds this exact slot: a
 * re-POST is the ONLY mechanism that advances a deferred rendition, so
 * refusing it at the cap would make a pool at its cap stall forever.
 *
 * Fails open, per this file's module doc: unreachable Valkey admits rather
 * than refuses.
 */
export async function admitAndHoldPrepareSlot(
    userId: string,
    member: string,
    cap: number,
): Promise<boolean> {
    return sAddBounded(prepareSlotKey(userId), member, Math.max(1, cap), slotTtlSeconds());
}

/**
 * Whether a pool request may proceed. Pure reference implementation of the
 * policy `admitAndHoldPrepareSlot`'s Lua script enforces atomically — kept
 * for unit coverage of the semantics in isolation, without a Valkey
 * round trip. NOT the live gate: a real request goes through
 * `admitAndHoldPrepareSlot`, because a decision made from a separately-read
 * `pending` snapshot (as calling this against `pendingPrepareSlots()` would
 * be) reintroduces the exact TOCTOU window that function exists to close.
 */
export function admitsPrepare(pending: string[], member: string, cap: number): boolean {
    if (pending.includes(member)) return true;
    return pending.length < Math.max(1, cap);
}

/**
 * Cheap PRE-CHECK, run before the caller pays for a probe to learn the exact
 * `(file, rung, audio)` member.
 *
 * The real admission decision is `admitAndHoldPrepareSlot`, which needs the
 * audio index — and the audio index is only known after `probeMediaFile()`
 * runs when the request omits one (the common case: candidate rows carry no
 * `audioIndex` by design, see `series-downloads.queries.ts`'s module
 * docstring). Once the user is confirmed at cap and NOT already holding a
 * slot for this exact `(fileId, rungId)` — under any audio index — the
 * eventual `admitAndHoldPrepareSlot` call cannot admit them either, so there
 * is no reason to pay for the probe first. This can only produce a false
 * "maybe, go probe"; it can never produce a false reject, because
 * `admitAndHoldPrepareSlot`'s exact-member check still runs afterward and is
 * the final authority.
 */
export function mayAttemptPrepare(
    pending: string[],
    fileId: string,
    rungId: string,
    cap: number,
): boolean {
    if (pending.length < Math.max(1, cap)) return true;
    const prefix = `${fileId}:${rungId}:`;
    return pending.some((m) => m.startsWith(prefix));
}
