// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';

/**
 * Stable identity for an EPG programme.
 *
 * Every refresh replaces a channel's listings wholesale (DELETE + INSERT), so a
 * database-assigned `gen_random_uuid()` handed each programme a brand new id
 * every few hours. Clients cache the guide for the length of a session —
 * jellyfin-androidtv holds it in TvManager until the app is killed — and then
 * ask for a programme by the id they were given, so every refresh silently
 * invalidated every open guide: `GET /j/Items/{programId}` started returning 404
 * for listings that were still on screen.
 *
 * Deriving the id from the programme's natural key instead means a listing that
 * survives a refresh keeps the identity the client already knows.
 *
 * The key is (channel, start instant). A channel airs one thing at a time, and
 * `collapseByChannel` in epg-schedule.ts enforces exactly that before anything
 * is persisted: zero-length and overlapping entries are dropped, so no two
 * surviving programmes on one channel share a start. Title and epg_id are
 * deliberately NOT part of the key — a corrected title or a re-matched feed
 * variant is still the same broadcast, and folding either in would resurrect the
 * churn this exists to prevent.
 */

// Fixed namespace — see RFC 4122 §4.3. Never change it: every persisted
// programme id is derived from it, so a new namespace is a full re-key.
const NAMESPACE = 'a8f1c4d2-6b93-4e07-9a5f-2c8e10b7d64a';

function namespaceBytes(): Buffer {
    return Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex');
}

function formatUuid(bytes: Buffer): string {
    const hex = bytes.subarray(0, 16).toString('hex');
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
    ].join('-');
}

/**
 * RFC 4122 v5 (SHA-1, name-based) UUID for a programme.
 *
 * @param channelId Our `livetv_channels.id` — not the feed's tvg-id, which can
 *                  point at several of our channels at once.
 * @param startTime Programme start, in any form `Date.parse` accepts. Hashed as
 *                  an epoch instant so a re-spelled offset is still the same id.
 * @throws If `startTime` cannot be parsed.
 */
export function programUuid(channelId: string, startTime: string | Date): string {
    const instant = startTime instanceof Date ? startTime.getTime() : Date.parse(startTime);
    if (!Number.isFinite(instant)) {
        throw new Error(`programUuid: unparseable start time ${String(startTime)}`);
    }

    const name = `${channelId.toLowerCase()}|${instant}`;
    const hash = createHash('sha1').update(namespaceBytes()).update(name, 'utf8').digest();

    // Stamp version (5) and the RFC 4122 variant into the truncated digest.
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;

    return formatUuid(hash);
}
