// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { normalizeUuid } from '$lib/server/utils/media-key-parser';
import { randomUUID } from 'node:crypto';
import {
    cacheGet,
    cacheSet,
    setIfNotExists,
    cacheDel,
    expire,
    hSetWithMaxTtl,
    hGetAll,
    hGet,
    isValkeyReadyFor,
} from '$lib/server/cache/valkey';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('JellyfinCompat:PlayToken');

const TOKEN_PREFIX = 'directplay:token:';
const SESSION_PREFIX = 'directplay:session:';
const FILE_SESSION_PREFIX = 'directplay:session-files:v1:';
const MIN_TTL_SECONDS = 4 * 60 * 60; // 4 h floor
const RENEWAL_TTL_SECONDS = 4 * 60 * 60; // reset to 4 h on renewal

export interface PlayTokenData {
    /** Validation-only handle for looking up session indexes of pre-upgrade tokens. Never stored. */
    tokenId?: string;
    /** Trusted issuance identity; never substitute a request's PlaySessionId for it. */
    playSessionId?: string;
    deviceId?: string;
    itemId: string;
    /**
     * The USERNAME of the user the token was issued to (PlaybackInfo passes
     * `event.locals.user.username`), not the users.id UUID — every consumer
     * (`buildPlayTokenUserContext`, `checkSessionKickCooldown`,
     * `disarmSilentStart`) treats it as a username. Kept under this name so
     * tokens issued before a rename keep decoding.
     */
    userId: string;
    /** Present on per-file tokens (used as MediaSource.Id for direct play). */
    fileId?: string;
    /**
     * The request that issued this token had real admin capability
     * (`principal.isAdmin`, never the owner's flag). Absent on tokens issued
     * before this field existed: they stay non-admin.
     */
    mintedByAdmin?: boolean;
}

export interface IssuePlayTokenOptions {
    deviceId?: string;
    /** Bind every direct-play source token to the client playback for revocation/renewal. */
    playSessionId?: string;
    /**
     * Admin capability of the issuing request (`playTokenMintedByAdmin`).
     * Live TV tokens omit it on purpose: channels are not library-gated.
     */
    mintedByAdmin?: boolean;
}

function tokenKey(token: string): string {
    return `${TOKEN_PREFIX}${token}`;
}

function sessionKey(playSessionId: string): string {
    return `${SESSION_PREFIX}${playSessionId}`;
}

/**
 * Issue a short-lived play token scoped to one item.
 * TTL = max(content runtime + 2 h buffer, 4 h).
 * Stores two keys: token → data, session → token (for progress-based renewal).
 */
export async function issuePlayToken(
    itemId: string,
    userId: string,
    playSessionId: string,
    runtimeSeconds?: number | null,
    opts?: IssuePlayTokenOptions,
): Promise<string> {
    const token = randomUUID();
    const ttlSeconds = Math.max(MIN_TTL_SECONDS, (runtimeSeconds ?? 0) + 2 * 60 * 60);
    const data = JSON.stringify({
        itemId,
        userId,
        playSessionId,
        deviceId: opts?.deviceId,
        mintedByAdmin: opts?.mintedByAdmin === true,
    } satisfies PlayTokenData);
    // The id was checked by freshPlaySessionId; NX closes simultaneous claims.
    if (!(await setIfNotExists(sessionKey(playSessionId), token, ttlSeconds))) {
        throw new Error('PlaySessionId already in use or storage unavailable');
    }
    await cacheSet(tokenKey(token), data, ttlSeconds);
    logger.debug('Issued play token', {
        itemId,
        userId,
        playSessionId,
        ttlSeconds,
    });
    return token;
}

/**
 * Issue a per-file token used as the MediaSource.Id for direct play.
 * ExoPlayer constructs /Videos/{token}/stream?... — the stream route validates
 * this token and resolves the real itemId + fileId from it.
 * All source tokens are indexed by PlaySessionId when provided, so a kick revokes
 * every version without overwriting the ordinary session token.
 */
export async function issueFileToken(
    itemId: string,
    fileId: string,
    userId: string,
    runtimeSeconds?: number | null,
    opts?: IssuePlayTokenOptions,
): Promise<string> {
    const token = randomUUID();
    const ttlSeconds = Math.max(MIN_TTL_SECONDS, (runtimeSeconds ?? 0) + 2 * 60 * 60);
    const data = JSON.stringify({
        itemId,
        fileId,
        userId,
        playSessionId: opts?.playSessionId,
        deviceId: opts?.deviceId,
        mintedByAdmin: opts?.mintedByAdmin === true,
    } satisfies PlayTokenData);
    await cacheSet(tokenKey(token), data, ttlSeconds);
    if (opts?.playSessionId) {
        const key = `${FILE_SESSION_PREFIX}${opts.playSessionId}`;
        // Atomic per-token fields: parallel version issuance must not lose siblings.
        await hSetWithMaxTtl(key, token, token, ttlSeconds);
    }
    return token;
}

/**
 * Validate a play token. Returns the stored data or null if missing/expired.
 */
export async function validatePlayToken(token: string): Promise<PlayTokenData | null> {
    try {
        const raw = await cacheGet(tokenKey(token));
        if (!raw) return null;
        return { ...(JSON.parse(raw) as PlayTokenData), tokenId: token };
    } catch {
        return null;
    }
}

/** Verify an old token's session mapping without trusting a client-supplied id. */
export async function isPlayTokenBoundToSession(
    token: string,
    playSessionId: string,
): Promise<boolean> {
    const [root, file] = await Promise.all([
        cacheGet(sessionKey(playSessionId)),
        hGet(`${FILE_SESSION_PREFIX}${playSessionId}`, token),
    ]);
    return root === token || file === token;
}

/**
 * Revoke the token(s) bound to a play session so subsequent byte-range / HLS
 * segment requests carrying them stop validating (hard-cuts the stream rather
 * than relying on the client to honour a kick response).
 */
export async function revokePlayTokenBySession(playSessionId: string): Promise<void> {
    // Cache wrappers normally no-op without a client. Revocation must be visible
    // to operators: log at ERROR rather than pretending it succeeded. We choose
    // loud best-effort revocation during outages; no process-local denylist can
    // protect other replicas. Completed/non-allowed sessions are also refused by
    // the database-backed byte gate while admission backoff is available.
    if (!isValkeyReadyFor(sessionKey(playSessionId))) {
        logger.error('Cannot revoke play tokens: Valkey unavailable', { playSessionId });
        return;
    }
    try {
        const fileKey = `${FILE_SESSION_PREFIX}${playSessionId}`;
        const [token, files] = await Promise.all([
            cacheGet(sessionKey(playSessionId)),
            hGetAll(fileKey),
        ]);
        const keys = [sessionKey(playSessionId), fileKey, ...Object.keys(files).map(tokenKey)];
        if (token) keys.push(tokenKey(token));
        await cacheDel(keys);
    } catch (err) {
        logger.warn('Failed to revoke play token', { playSessionId }, err as Error);
    }
}

/**
 * Renew both keys associated with a play session, resetting their TTL.
 * Called on every playback progress heartbeat so long movies don't expire.
 */
export async function renewPlayTokenBySession(
    playSessionId: string,
    evidence: { token: string } | { userId: string; itemId: string },
): Promise<void> {
    try {
        if ('token' in evidence) {
            if (!(await isPlayTokenBoundToSession(evidence.token, playSessionId))) return;
        } else {
            // Progress reports have a /j session credential, not a play token.
            // Resolve a mapped token and verify BOTH the caller and playable item.
            const root = await cacheGet(sessionKey(playSessionId));
            const files = root ? {} : await hGetAll(`${FILE_SESSION_PREFIX}${playSessionId}`);
            const token = root ?? Object.keys(files)[0];
            if (!token || !(await isPlayTokenBoundToSession(token, playSessionId))) return;
            const data = await validatePlayToken(token);
            if (
                !data ||
                data.userId.toLowerCase() !== evidence.userId.toLowerCase() ||
                normalizeUuid(data.itemId).toLowerCase() !==
                    normalizeUuid(evidence.itemId).toLowerCase()
            )
                return;
        }
        const fileKey = `${FILE_SESSION_PREFIX}${playSessionId}`;
        const [token, files] = await Promise.all([
            cacheGet(sessionKey(playSessionId)),
            hGetAll(fileKey),
        ]);
        const keys = [sessionKey(playSessionId), fileKey, ...Object.keys(files).map(tokenKey)];
        if (token) keys.push(tokenKey(token));
        await Promise.all(keys.map((key) => expire(key, RENEWAL_TTL_SECONDS)));
    } catch (err) {
        logger.warn('Failed to renew play token', { playSessionId }, err as Error);
    }
}
