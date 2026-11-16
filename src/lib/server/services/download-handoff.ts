// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hand-off nonces: how the web queue's link mode learns that a download it handed to the
 * browser actually reached the server.
 *
 * The queue puts a fresh random id on the download URL (`?h=<nonce>`); the download handler
 * records it here once it starts serving; `GET /api/me/downloads/slots?h=<nonce>` reports
 * `started` only when THAT nonce was seen for THIS user. Another device's or tab's download
 * of the same file therefore cannot confirm it. No database column: Valkey (shared by all
 * replicas) with a short TTL, process-local when Valkey is not there or errors.
 */

import { getCoordinationClient } from '$lib/server/cache/valkey.js';

const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TTL_SEC = 120;
const MAX_LOCAL = 2_000;

const local = new Map<string, number>();

const keyOf = (userId: string, nonce: string): string => `dl:v2:handoff:${userId}:${nonce}`;

/** A well-formed nonce, or null (never trusted beyond its shape). */
export function parseHandoffNonce(raw: string | null | undefined): string | null {
    return raw && NONCE_RE.test(raw) ? raw : null;
}

/** Test hook. */
export function resetHandoffsForTests(): void {
    local.clear();
}

/** Remember that this user's hand-off `nonce` reached the server. Never throws. */
export async function noteHandoff(userId: string, nonce: string): Promise<void> {
    const key = keyOf(userId, nonce);
    const now = Date.now();
    if (local.size > MAX_LOCAL) {
        for (const [k, until] of local) if (until <= now) local.delete(k);
        if (local.size > MAX_LOCAL) local.clear();
    }
    local.set(key, now + TTL_SEC * 1000);
    try {
        await getCoordinationClient()?.customCommand(['SET', key, '1', 'EX', String(TTL_SEC)]);
    } catch {
        // the process-local copy still answers on this replica
    }
}

/** Whether `nonce` was noted for this user, on any replica. */
export async function handoffSeen(userId: string, nonce: string): Promise<boolean> {
    const key = keyOf(userId, nonce);
    const until = local.get(key);
    if (until !== undefined && until > Date.now()) return true;
    try {
        const client = getCoordinationClient();
        if (!client) return false;
        return Number(await client.customCommand(['EXISTS', key])) > 0;
    } catch {
        return false;
    }
}
