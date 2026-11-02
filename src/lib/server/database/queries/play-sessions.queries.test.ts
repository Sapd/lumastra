// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for play-sessions query module (findActiveSession)
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { UNLIMITED_CONCURRENT_STREAMS } from '$lib/schemas/play-sessions';
import {
    findActiveSession,
    getEffectivePolicy,
    deleteStreamPolicy,
    UNMETERED_SOURCES,
    unmeteredSources,
    type ActivePlaySessionRow,
} from './play-sessions.queries.js';

const TEST_USER_ALICE = toUserId('aaaaaaaa-0000-0000-0000-000000000001');
const TEST_USER_TESTUSER = toUserId('bbbbbbbb-0000-0000-0000-000000000002');

describe('play-sessions.queries', () => {
    describe('exports', () => {
        it('exports findActiveSession function', () => {
            expect(typeof findActiveSession).toBe('function');
        });
    });

    describe('ActivePlaySessionRow type', () => {
        it('compiles with expected shape', () => {
            const row: ActivePlaySessionRow = {
                id: 'session-uuid',
                media_id: 'media-uuid',
                user_id: TEST_USER_TESTUSER,
                play_method: 'direct',
                status: 'ACTIVE',
                position_ms: 12000,
                bitrate_kbps: 8000,
                video_codec: 'h264',
                audio_codec: 'aac',
                resolution: '1920x1080',
            };

            expect(row.id).toBe('session-uuid');
            expect(row.status).toBe('ACTIVE');
            expect(row.position_ms).toBe(12000);
        });

        it('compiles with null optional fields', () => {
            const row: ActivePlaySessionRow = {
                id: 'session-uuid',
                media_id: 'media-uuid',
                user_id: TEST_USER_TESTUSER,
                play_method: 'transcode',
                status: 'PAUSED',
                position_ms: 0,
                bitrate_kbps: null,
                video_codec: null,
                audio_codec: null,
                resolution: null,
            };

            expect(row.bitrate_kbps).toBeNull();
        });
    });

    describe('findActiveSession', () => {
        it('returns the first matching session row', async () => {
            const mockRow: ActivePlaySessionRow = {
                id: 'session-1',
                media_id: 'media-1',
                user_id: TEST_USER_ALICE,
                play_method: 'direct',
                status: 'ACTIVE',
                position_ms: 5000,
                bitrate_kbps: null,
                video_codec: null,
                audio_codec: null,
                resolution: null,
            };

            const mockSql = vi.fn().mockResolvedValue([mockRow]) as unknown as postgres.Sql;

            const result = await findActiveSession(mockSql, {
                userId: TEST_USER_ALICE,
                itemId: 'jf-item-1',
            });

            expect(result).toBe(mockRow);
        });

        it('returns null when no session found', async () => {
            const mockSql = vi.fn().mockResolvedValue([]) as unknown as postgres.Sql;

            const result = await findActiveSession(mockSql, {
                userId: TEST_USER_ALICE,
                itemId: 'unknown-item',
            });

            expect(result).toBeNull();
        });
    });

    describe('getEffectivePolicy — synthetic fallback', () => {
        // No user-specific or `__default__` row exists (both SELECTs empty) —
        // exercises the synthetic fallback object built in-module.
        it('uses fallbackDefaults.max_concurrent_streams when provided', async () => {
            const mockSql = vi.fn().mockResolvedValue([]) as unknown as postgres.Sql;

            const policy = await getEffectivePolicy(mockSql, '__default__', {
                max_concurrent_streams: 7,
            });

            expect(policy.max_concurrent_streams).toBe(7);
        });

        it('falls back to unlimited (-1) when no fallbackDefaults are provided (pure-module default)', async () => {
            const mockSql = vi.fn().mockResolvedValue([]) as unknown as postgres.Sql;

            const policy = await getEffectivePolicy(mockSql, '__default__');

            expect(policy.max_concurrent_streams).toBe(UNLIMITED_CONCURRENT_STREAMS);
        });

        it('a per-user or `__default__` row still wins over fallbackDefaults', async () => {
            const mockSql = vi
                .fn()
                .mockResolvedValueOnce([
                    { user_id: 'someuser', max_concurrent_streams: 5 },
                ]) as unknown as postgres.Sql;

            const policy = await getEffectivePolicy(mockSql, 'someuser', {
                max_concurrent_streams: 7,
            });

            expect(policy.max_concurrent_streams).toBe(5);
        });
    });

    describe('deleteStreamPolicy', () => {
        it('returns true when a row was deleted', async () => {
            const mockSql = vi
                .fn()
                .mockResolvedValue([{ user_id: 'someuser' }]) as unknown as postgres.Sql;

            const result = await deleteStreamPolicy(mockSql, 'someuser');

            expect(result).toBe(true);
        });

        it('returns false when there was nothing to delete', async () => {
            const mockSql = vi.fn().mockResolvedValue([]) as unknown as postgres.Sql;

            const result = await deleteStreamPolicy(mockSql, 'someuser');

            expect(result).toBe(false);
        });
    });
});

/**
 * The stream-limit exemption set.
 *
 * `'local'` says "this playback is a file already on the client's device". The
 * server sees no bytes either way, so the claim is structurally unverifiable —
 * a modified client could send it on every session. Whether it exempts a
 * session from the concurrent-stream limit is therefore an OPERATOR decision
 * (`TRUST_CLIENT_LOCAL_PLAYBACK`), and these pin that the decision is real
 * rather than decorative: an install that has not opted in must count local
 * sessions exactly like any other.
 */
describe('unmeteredSources — the stream-limit exemption set', () => {
    it('exempts local playback only when the operator trusts the claim', () => {
        expect(unmeteredSources(true)).toContain('local');
        expect(unmeteredSources(false)).not.toContain('local');
    });

    it('always exempts the sources that are unmeterable as a matter of fact', () => {
        // Jellyfin/Subsonic rows mirror another server's playback: not a policy
        // choice, so no config may withdraw them. If this ever fails, a config
        // flag has been wired to something it must not control.
        for (const trust of [true, false]) {
            expect(unmeteredSources(trust)).toEqual(expect.arrayContaining(UNMETERED_SOURCES));
        }
    });

    it('never mutates the shared constant', () => {
        // `unmeteredSources(true)` must build a NEW array. Pushing onto the
        // exported one would make the first trusted call permanently exempt
        // local sessions for every later untrusted caller in the process.
        const before = [...UNMETERED_SOURCES];
        unmeteredSources(true);
        unmeteredSources(true);
        expect(UNMETERED_SOURCES).toEqual(before);
        expect(unmeteredSources(false)).not.toContain('local');
    });

    it('does not exempt first-party sources that DO cost this server bytes', () => {
        // A regression here would let an ordinary stream, a Live TV tune, or an
        // audiobook we proxy escape the limit entirely.
        for (const trust of [true, false]) {
            const set = unmeteredSources(trust);
            expect(set).not.toContain('lumastra');
            expect(set).not.toContain('livetv');
            expect(set).not.toContain('audiobookshelf');
            expect(set).not.toContain('music');
        }
    });
});
