// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch-party overlay for the Active Streams view — pure, no I/O.
 *
 * A watch party is N ordinary play sessions (one per participant device) that
 * the Active Streams widget would otherwise render as N unrelated cards. This
 * module tags each visible stream row with the party it belongs to, so the
 * widget can fold them into one "watching together" card, and attaches a
 * display-only sync reading (party state + this row's offset from the host).
 *
 * Visibility (decided 2026-09-27):
 *  - public party          → grouped for everyone who can see the rows; the
 *                            join code is exposed unless the admin switched the
 *                            watch-parties listing off.
 *  - private party         → grouped only for its participants and admins;
 *                            everyone else sees plain, unrelated streams (the
 *                            fact that they watch together is not revealed).
 *                            Only participants get the code.
 *
 * The Valkey reads live in watch-together.service.ts
 * (`getPartyStreamSnapshots`); keeping this half pure keeps it unit-testable.
 */

import { createHash } from 'node:crypto';
import type { StreamSession } from '../types.js';
import {
    POSITION_SAMPLE_MAX_AGE_MS,
    projectPositionSample,
    type WatchTogetherPositionSample,
} from './watch-together-drift.js';

/**
 * Offset (seconds) beyond which the widget calls a party "drifting". Display
 * only — the player's own correction thresholds are separate and stricter
 * about acting; this is about what a human would notice as "out of sync".
 */
export const PARTY_DRIFT_WARN_SECONDS = 2;

export type PartySyncState = 'synced' | 'drifting' | 'buffering' | 'paused' | 'unknown';

/** Everything the overlay needs about one party, read from Valkey. */
import type { PublicAuthor } from '$lib/schemas/public-author';

export interface PartyStreamSnapshot {
    code: string;
    visibility: 'unlisted' | 'listed';
    itemId: string;
    host: PublicAuthor;
    hostClientId?: string;
    isPlaying: boolean;
    playbackRate: number;
    participants: ReadonlyArray<{ userId: string; displayName: string; clientId: string }>;
    /** clientId → latest fresh position sample (server receipt time). */
    positions: ReadonlyMap<string, WatchTogetherPositionSample>;
    /** clientIds currently stalled (buffering) within the active window. */
    stalledClientIds: ReadonlySet<string>;
    /** A group buffer check (everyone waits for everyone) is in flight. */
    bufferCheckPending: boolean;
}

export type StreamWatchParty = NonNullable<StreamSession['watchParty']>;

export interface PartyOverlayViewer {
    userId?: string;
    username?: string;
    isAdmin: boolean;
    /** False when the admin disabled the public watch-parties listing. */
    publicListingEnabled: boolean;
}

/** Opaque, stable group key — never the join code itself (it is the secret). */
export function partyGroupId(code: string): string {
    return createHash('sha256')
        .update(`watch-party:${code.toUpperCase()}`)
        .digest('hex')
        .slice(0, 16);
}

/** Signed offset of each client from the host, projected to `now`. */
export function computeClientOffsets(
    snapshot: PartyStreamSnapshot,
    now: number,
): Map<string, number> {
    const offsets = new Map<string, number>();
    const fresh = [...snapshot.positions.entries()].filter(([, s]) => {
        const age = now - s.timestamp;
        return Number.isFinite(s.position) && age >= 0 && age <= POSITION_SAMPLE_MAX_AGE_MS;
    });
    const hostEntry =
        fresh.find(([clientId]) => clientId === snapshot.hostClientId) ??
        fresh.find(([, s]) => s.isHost);
    if (!hostEntry) return offsets;
    const hostPos = projectPositionSample(
        hostEntry[1],
        now,
        snapshot.isPlaying,
        snapshot.playbackRate,
    );
    for (const [clientId, sample] of fresh) {
        const pos = projectPositionSample(sample, now, snapshot.isPlaying, snapshot.playbackRate);
        offsets.set(clientId, clientId === hostEntry[0] ? 0 : pos - hostPos);
    }
    return offsets;
}

export function computePartySyncState(
    snapshot: PartyStreamSnapshot,
    offsets: ReadonlyMap<string, number>,
): PartySyncState {
    if (snapshot.bufferCheckPending || snapshot.stalledClientIds.size > 0) return 'buffering';
    if (!snapshot.isPlaying) return 'paused';
    // Need the host plus at least one guest to say anything about sync.
    if (offsets.size < 2) return 'unknown';
    for (const offset of offsets.values()) {
        if (Math.abs(offset) > PARTY_DRIFT_WARN_SECONDS) return 'drifting';
    }
    return 'synced';
}

/** One decimal place, so the tooltip doesn't flicker on sub-100ms noise. */
function roundOffset(value: number): number {
    const rounded = Math.round(value * 10) / 10;
    return Object.is(rounded, -0) ? 0 : rounded;
}

type PartyStreamRow = Pick<
    StreamSession,
    'id' | 'mediaItemId' | 'seriesId' | 'userId' | 'watchParty'
>;

function rowMatchesPartyItem(row: PartyStreamRow, itemId: string): boolean {
    return row.mediaItemId === itemId || row.id === itemId || row.seriesId === itemId;
}

/**
 * Tag every stream row that belongs to a party the viewer may see as a party.
 * Returns new row objects; rows outside any (visible) party pass through
 * untouched.
 */
export function annotateStreamsWithParties<T extends PartyStreamRow>(
    sessions: T[],
    parties: readonly PartyStreamSnapshot[],
    viewer: PartyOverlayViewer,
    now: number = Date.now(),
): (T & { watchParty?: StreamWatchParty })[] {
    if (parties.length === 0 || sessions.length === 0) return sessions;

    const tags = new Map<number, StreamWatchParty>();

    for (const party of parties) {
        const viewerIsParticipant = party.participants.some((p) => p.userId === viewer.userId);
        if (party.visibility !== 'listed' && !viewer.isAdmin && !viewerIsParticipant) continue;

        const offsets = computeClientOffsets(party, now);
        const syncState = computePartySyncState(party, offsets);
        const exposeCode =
            viewerIsParticipant || (party.visibility === 'listed' && viewer.publicListingEnabled);
        const groupId = partyGroupId(party.code);

        sessions.forEach((row, index) => {
            if (tags.has(index)) return;
            if (!rowMatchesPartyItem(row, party.itemId)) return;
            const clients = party.participants.filter((p) => p.userId === row.userId);
            if (clients.length === 0) return;

            // The same user can be in a party from several devices; we cannot
            // tell which play session is which client, so report the worst.
            let drift: number | undefined;
            for (const c of clients) {
                const o = offsets.get(c.clientId);
                if (o !== undefined && (drift === undefined || Math.abs(o) > Math.abs(drift))) {
                    drift = o;
                }
            }
            const isHost = clients.some(
                (c) => c.userId === party.host.userId || c.clientId === party.hostClientId,
            );

            tags.set(index, {
                groupId,
                ...(exposeCode ? { code: party.code } : {}),
                visibility: party.visibility,
                isHost,
                host: party.host,
                participantCount: party.participants.length,
                viewerIsParticipant,
                syncState,
                ...(drift !== undefined && !isHost ? { driftSeconds: roundOffset(drift) } : {}),
                ...(clients.some((c) => party.stalledClientIds.has(c.clientId))
                    ? { isStalled: true }
                    : {}),
            });
        });
    }

    if (tags.size === 0) return sessions;
    return sessions.map((row, index) => {
        const watchParty = tags.get(index);
        return watchParty ? { ...row, watchParty } : row;
    });
}
