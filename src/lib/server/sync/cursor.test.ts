// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { accessTag, decodeSyncCursor, encodeSyncCursor, type SyncCursor } from './cursor';

vi.mock('$lib/server/config', () => ({ config: { JWT_SECRET: 'cursor-unit-test-secret' } }));
const userId = '11111111-1111-4111-8111-111111111111';
const cursor: SyncCursor = {
    instanceId: '22222222-2222-4222-8222-222222222222',
    epoch: 4,
    xid: '9007199254740993',
    seq: '9876543210987654',
    userId,
    accessTag: accessTag({ deniedGroupIds: null, ageRating: null }),
};
describe('sync cursor', () => {
    it('round trips without losing bigint precision', () => {
        expect(decodeSyncCursor(encodeSyncCursor(cursor), userId)).toEqual({
            status: 'ok',
            cursor,
        });
    });
    it('rejects a tampered MAC as invalid', () => {
        const bytes = Buffer.from(encodeSyncCursor(cursor), 'base64url');
        bytes[bytes.length - 1] ^= 1;
        expect(decodeSyncCursor(bytes.toString('base64url'), userId)).toEqual({
            status: 'invalid',
        });
    });
    it('rejects tampering with the payload before interpreting its fields', () => {
        const bytes = Buffer.from(encodeSyncCursor(cursor), 'base64url');
        bytes[0] ^= 1;
        expect(decodeSyncCursor(bytes.toString('base64url'), userId)).toEqual({
            status: 'invalid',
        });
    });
    it('rejects another user', () => {
        expect(decodeSyncCursor(encodeSyncCursor(cursor), cursor.instanceId)).toEqual({
            status: 'invalid',
        });
    });
    it.each(['', '%%%', 'YQ', 'not-a-cursor', 'a'.repeat(2049)])('rejects malformed %s', (raw) => {
        expect(decodeSyncCursor(raw, userId)).toEqual({ status: 'malformed' });
    });
    it('hashes only effective scope and is stable under reordering and duplicates', () => {
        expect(accessTag({ deniedGroupIds: ['b', 'a', 'a'], ageRating: null })).toBe(
            accessTag({ deniedGroupIds: ['a', 'b'], ageRating: null }),
        );
    });
    it('changes on age limit and unrated policy changes', () => {
        const tag = (maxAgeRating: number, allowUnrated: boolean): string =>
            accessTag({
                deniedGroupIds: null,
                ageRating: { maxAgeRating, allowUnrated },
            });
        expect(tag(12, true)).not.toBe(tag(16, true));
        expect(tag(12, true)).not.toBe(tag(12, false));
    });
});
