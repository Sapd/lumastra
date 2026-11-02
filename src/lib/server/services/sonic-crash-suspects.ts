// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tracks that were in flight when the sonic embedder went down.
 *
 * An outage says nothing about the tracks (see SonicEngineError), so none of
 * them is charged a failed attempt. That leaves one case open: a file that
 * makes the sidecar process itself crash. To the backfill it looks exactly like
 * an outage, so without this it would never be charged, the drain would stop at
 * it on every run (pending tracks are taken in id order), and every track
 * behind it would wait forever.
 *
 * So the tracks of the request in flight when the sidecar failed are remembered
 * here, and the backfill embeds a suspect ALONE, behind a readiness check. If
 * the sidecar was ready right before and goes down during that single file, the
 * file gets a STRIKE. The first strike charges nothing — one coincidental
 * outage (a deploy, an OOM elsewhere) must not cost an innocent track an
 * attempt. From the second strike on, each crash is charged as a normal failed
 * attempt, so a file that really crashes the sidecar is written off like any
 * undecodable file after a few runs instead of blocking the queue forever.
 *
 * Sidecar mode only: the subprocess fallback already reports a file that
 * crashes it as that file's own failure (sonic-embedding.service.ts,
 * embedOneByOne).
 *
 * Valkey, not the DB: the set is small, best-effort and self-expiring, and the
 * task system already requires Valkey. If it is unavailable the backfill simply
 * behaves as before this module existed.
 */

import { sAdd, sMembers, sRem, expire } from '../cache/valkey.js';

const KEY = 'v1:sonic:embed-crash-suspects';
/** Suspects that already took the sidecar down once while embedded alone. */
const STRUCK_KEY = 'v1:sonic:embed-crash-struck';

/** Long enough to outlive any outage; a suspect that is never fetched again just ages out. */
const TTL_SECONDS = 30 * 24 * 60 * 60;

export async function markCrashSuspects(mediaIds: readonly string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    try {
        await sAdd(KEY, ...mediaIds);
        await expire(KEY, TTL_SECONDS);
    } catch {
        // Best-effort.
    }
}

export async function loadCrashSuspects(): Promise<Set<string>> {
    try {
        return new Set(await sMembers(KEY));
    } catch {
        return new Set();
    }
}

/**
 * Record that `mediaId`, embedded alone, took the sidecar down. Returns whether
 * it had done so before — i.e. whether this crash should be charged.
 */
export async function strikeCrashSuspect(mediaId: string): Promise<boolean> {
    try {
        const struckBefore = new Set(await sMembers(STRUCK_KEY)).has(mediaId);
        await sAdd(STRUCK_KEY, mediaId);
        await expire(STRUCK_KEY, TTL_SECONDS);
        return struckBefore;
    } catch {
        // Unknown history: never charge on a guess.
        return false;
    }
}

/** The track produced a real answer (embedded, or a per-file failure): forget it. */
export async function clearCrashSuspects(mediaIds: readonly string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    try {
        await sRem(KEY, ...mediaIds);
        await sRem(STRUCK_KEY, ...mediaIds);
    } catch {
        // Best-effort.
    }
}
