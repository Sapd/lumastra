// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { revokeGrantsForPlaySession } from './playback-grant.js';

import type postgres from 'postgres';
import { killSession as killSessionQuery } from '$lib/server/database/queries/play-sessions.queries.js';
import { stopSessionTranscode } from './play-session-transcode-cleanup.js';
import { notifySessionKilled } from '$lib/server/services/play-session-events.service.js';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import { TimeUnit } from '@valkey/valkey-glide';
import { foldUsername } from '$lib/shared/username-fold.js';

const logger = Logger.for('SessionKillService');

const KICK_COOLDOWN_SECONDS = 120;
const KICK_KEY_PREFIX = 'sessions:v1:kicked:';

export interface KillResult {
    killed: boolean;
    source: 'database';
    username?: string;
}

export interface KickStatus {
    kicked: boolean;
    reason?: string;
    remainingSeconds?: number;
}

export interface KillOptions {
    /**
     * Whether to set the 120s kick cooldown that blocks new manifest fetches
     * for this user. Admin kills keep this on (default true) so a kicked user
     * can't immediately re-authorize the same stream. Callers that want the
     * user to be able to start a new (within-limit) stream right away — e.g.
     * the stream-limit reconciler's grace-then-kick — pass `false`.
     */
    setCooldown?: boolean;
    /** Overrides the default `admin:<killedBy>` stop_reason and SSE kill reason. */
    reason?: string;
}

export async function killSessionUnified(
    sql: postgres.Sql,
    sessionId: string,
    killedBy: string,
    options?: KillOptions,
): Promise<KillResult | null> {
    const setCooldown = options?.setCooldown ?? true;
    const reason = options?.reason;
    const dbRow = await killSessionQuery(sql, sessionId, killedBy, reason);
    if (!dbRow) return null;
    await revokeGrantsForPlaySession(sessionId, sql, 'admin_kill');
    if (dbRow.purpose === 'play') {
        const { expireMusicPrefetchForSession } = await import('./play-sessions.service.js');
        await expireMusicPrefetchForSession(sql, sessionId);
    }

    try {
        notifySessionKilled(sessionId, reason ?? 'admin');
    } catch (err) {
        logger.warn('Failed to notify session killed', { sessionId, err });
    }
    // The kick cooldown is an anti-resurrection guard: after an admin kicks
    // SOMEONE ELSE, it stops that user's client from instantly re-fetching the
    // manifest and resurrecting the killed session for 120s. But when a user
    // stops their OWN session (e.g. clearing a stuck/ghost stream to free a slot
    // so they can start a fresh one), that same cooldown wrongly locks them out
    // of all new playback — the manifest fetch hits checkSessionKickCooldown and
    // returns 403, surfaced to the player as "your session is no longer
    // authorized". A self-kill is never a resurrection to guard against, so skip
    // the cooldown when the killer owns the session. (The stream-limit reconciler
    // already passes setCooldown:false for the same reason.)
    // Usernames reach here in whatever case the caller's auth path carried.
    const isSelfKill = foldUsername(killedBy) === foldUsername(dbRow.owner_username);
    if (setCooldown && !isSelfKill) {
        await setKickCooldown(dbRow.owner_username, killedBy, sessionId, reason);
    }
    await stopSessionTranscode(sessionId, reason ?? 'admin_kill');
    await cancelMusicStreamForSession(sql, sessionId);
    logger.info('Killed DB session', {
        sessionId,
        killedBy,
        reason: reason ?? 'admin',
        username: dbRow.owner_username,
    });
    return { killed: true, source: 'database', username: dbRow.owner_username };
}

async function setKickCooldown(
    username: string,
    killedBy: string,
    sessionId: string,
    reason?: string,
): Promise<void> {
    try {
        const valkey = getCoordinationClient();
        if (!valkey) return;
        const key = `${KICK_KEY_PREFIX}${foldUsername(username)}`;
        const value = JSON.stringify({
            // Honour a caller-supplied reason (e.g. the stream-limit reconciler);
            // fall back to admin:<killedBy> only when none was given. Keeps the
            // cooldown payload consistent with the DB stop_reason / SSE reason.
            reason: reason ?? `admin:${killedBy}`,
            sessionId,
            kickedAt: Date.now(),
        });
        await valkey.set(key, value, {
            expiry: { type: TimeUnit.Seconds, count: KICK_COOLDOWN_SECONDS },
        });
    } catch (err) {
        logger.warn('Failed to set kick cooldown in Valkey', { err, username });
    }
}

export async function cancelMusicStreamForSession(
    sql: postgres.Sql,
    sessionId: string,
): Promise<void> {
    try {
        const { getMusicTranscodeService } =
            await import('$lib/server/services/music-transcode/index.js');
        const cancelled = getMusicTranscodeService(sql).cancel(sessionId);
        if (cancelled) {
            logger.info('Cancelled music stream for killed session', { sessionId });
        }
    } catch (err) {
        if (err instanceof Error && !err.message.includes('import')) {
            logger.warn('Failed to cancel music stream for killed session', {
                sessionId,
                err,
            });
        }
    }
}

export async function checkSessionKickCooldown(username: string): Promise<KickStatus> {
    try {
        const valkey = getCoordinationClient();
        if (!valkey) return { kicked: false };
        const key = `${KICK_KEY_PREFIX}${foldUsername(username)}`;
        const raw = await valkey.get(key);
        if (!raw) return { kicked: false };
        const data = JSON.parse(raw as string) as {
            reason: string;
            sessionId: string;
            kickedAt: number;
        };
        const elapsed = (Date.now() - data.kickedAt) / 1000;
        const remaining = KICK_COOLDOWN_SECONDS - elapsed;
        if (remaining <= 0) return { kicked: false };
        return {
            kicked: true,
            reason: data.reason,
            remainingSeconds: Math.ceil(remaining),
        };
    } catch (e) {
        logger.warn('Failed to parse kick status from Valkey', {
            username,
            error: e,
        });
        return { kicked: false };
    }
}
