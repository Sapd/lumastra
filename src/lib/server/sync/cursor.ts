// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '$lib/server/config';
import type { SearchAccessContext } from '$lib/server/utils/search-access-context';

export interface SyncPosition {
    xid: string;
    seq: string;
}
export interface SyncCursor extends SyncPosition {
    instanceId: string;
    epoch: number;
    userId: string;
    accessTag: string;
}
export type DecodeSyncCursorResult =
    { status: 'ok'; cursor: SyncCursor } | { status: 'malformed' | 'invalid' };

function mac(payload: string): Buffer {
    if (!config.JWT_SECRET) throw new Error('JWT_SECRET must be configured for sync cursors');
    const key = createHmac('sha256', config.JWT_SECRET).update('sync-cursor').digest();
    return createHmac('sha256', key).update(payload).digest();
}

export function accessTag(ctx: Pick<SearchAccessContext, 'deniedGroupIds' | 'ageRating'>): string {
    const scope = [
        ctx.deniedGroupIds === null ? 'all' : [...new Set(ctx.deniedGroupIds)].sort(),
        ctx.ageRating?.maxAgeRating == null
            ? null
            : [ctx.ageRating.maxAgeRating, ctx.ageRating.allowUnrated],
    ];
    return createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 24);
}

export function encodeSyncCursor(cursor: SyncCursor): string {
    const payload = [
        'v1',
        cursor.instanceId,
        cursor.epoch,
        cursor.xid,
        cursor.seq,
        cursor.userId,
        cursor.accessTag,
    ].join('|');
    return Buffer.concat([Buffer.from(payload), Buffer.from('|'), mac(payload)]).toString(
        'base64url',
    );
}

export function decodeSyncCursor(raw: string, userId: string): DecodeSyncCursorResult {
    if (!raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) return { status: 'malformed' };
    const bytes = Buffer.from(raw, 'base64url');
    if (
        bytes.toString('base64url') !== raw ||
        bytes.length < 34 ||
        bytes[bytes.length - 33] !== 124
    ) {
        return { status: 'malformed' };
    }
    const payload = bytes.subarray(0, -33).toString('utf8');
    if (!timingSafeEqual(bytes.subarray(-32), mac(payload))) return { status: 'invalid' };
    const parts = payload.split('|');
    const [v, instanceId, epoch, xid, seq, owner, tag] = parts;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
        parts.length !== 7 ||
        v !== 'v1' ||
        !uuid.test(instanceId) ||
        !uuid.test(owner) ||
        !/^\d{1,10}$/.test(epoch) ||
        Number(epoch) > 2147483647 ||
        !/^\d{1,20}$/.test(xid) ||
        BigInt(xid) > 18446744073709551615n ||
        !/^\d{1,19}$/.test(seq) ||
        BigInt(seq) > 9223372036854775807n ||
        !/^[a-f0-9]{24}$/.test(tag)
    )
        return { status: 'malformed' };
    if (owner !== userId) {
        return { status: 'invalid' };
    }
    return {
        status: 'ok',
        cursor: { instanceId, epoch: Number(epoch), xid, seq, userId: owner, accessTag: tag },
    };
}

export function compareSyncPositions(a: SyncPosition, b: SyncPosition): number {
    const ax = BigInt(a.xid),
        bx = BigInt(b.xid);
    if (ax !== bx) return ax < bx ? -1 : 1;
    const as = BigInt(a.seq),
        bs = BigInt(b.seq);
    return as === bs ? 0 : as < bs ? -1 : 1;
}

export function syncVersion(position: SyncPosition): string {
    return `${position.xid.padStart(20, '0')}:${position.seq.padStart(20, '0')}`;
}
