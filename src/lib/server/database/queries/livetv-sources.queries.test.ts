// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for livetv-sources.queries.ts
 *
 * Tests JavaScript logic around return values (null coalescing, boolean conversion,
 * count parsing) without a real database connection.
 */

import { describe, it, expect, vi } from 'vitest';
import { deriveMasterKey, sealSecret, openSecret } from '$lib/server/crypto/secret-box.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import {
    getAllSources,
    getSourceById,
    getSourceByIdWithCredentials,
    createSource,
    updateSource,
    deleteSource,
    updateRefreshStatus,
    getSourceChannelCount,
    type LiveTvSourceSafeRow,
    type LiveTvSourceAdminRow,
    type LiveTvSourceRow,
} from './livetv-sources.queries.js';
import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeSql(returnValue: unknown): postgres.Sql {
    const fn = vi.fn().mockResolvedValue(returnValue);
    // Allow sql`...` sub-expressions (e.g. sql`name`) to work as fragment
    (fn as unknown as Record<string, unknown>).json = vi.fn((v: unknown) => v);
    return fn as unknown as postgres.Sql;
}

/**
 * The values interpolated into the LAST tagged-template call — i.e. what would
 * actually be bound and land in the table. `updateSource` evaluates its
 * `sql`name`` no-op fragments first, so the statement itself is the last call.
 */
function boundStrings(sql: postgres.Sql): string[] {
    const calls = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const last = calls[calls.length - 1] as unknown[];
    return last.slice(1).filter((v): v is string => typeof v === 'string');
}

/**
 * A 64-char hex master key, so sealing is available without touching the
 * filesystem. Set in a hoisted block: `resolveMasterKey()` memoizes the first
 * key it resolves, and something in the import graph resolves one at module
 * load — an env var set later would be ignored and the module would seal with a
 * different key than this file does.
 */
const TEST_MASTER_KEY = vi.hoisted(() => {
    const key = '0123456789abcdef'.repeat(4);
    process.env.LUMASTRA_MASTER_KEY = key;
    return key;
});

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const exampleSafeRow: LiveTvSourceSafeRow = {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'My M3U Source',
    source_type: 'm3u',
    max_streams: 2,
    refresh_cron: '0 * * * *',
    last_refresh_at: new Date('2026-01-01T00:00:00Z'),
    last_refresh_status: 'ok',
    last_refresh_summary: { channels: 100 },
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
};

const exampleAdminRow: LiveTvSourceAdminRow = {
    ...exampleSafeRow,
    m3u_url: 'http://example.com/playlist.m3u',
    xmltv_url: 'http://example.com/epg.xml',
};

const exampleFullRow: LiveTvSourceRow = {
    ...exampleAdminRow,
    xtream_server: null,
    xtream_username: null,
    xtream_password: null,
    hdhomerun_device_ip: null,
    hdhomerun_device_id: null,
};

const exampleXtreamRow: LiveTvSourceRow = {
    id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    name: 'Xtream Source',
    source_type: 'xtream',
    m3u_url: null,
    xmltv_url: null,
    xtream_server: 'http://xtream.example.com',
    xtream_username: 'user123',
    xtream_password: 's3cr3t',
    hdhomerun_device_ip: null,
    hdhomerun_device_id: null,
    max_streams: 1,
    refresh_cron: null,
    last_refresh_at: null,
    last_refresh_status: null,
    last_refresh_summary: null,
    created_at: new Date('2026-02-01T00:00:00Z'),
    updated_at: new Date('2026-02-01T00:00:00Z'),
};

// ---------------------------------------------------------------------------
// getAllSources
// ---------------------------------------------------------------------------

describe('getAllSources', () => {
    it('returns array of safe rows from sql result', async () => {
        const sql = makeSql([exampleSafeRow]);
        const result = await getAllSources(sql);
        expect(result).toEqual([exampleSafeRow]);
    });

    it('returns empty array when table is empty', async () => {
        const sql = makeSql([]);
        const result = await getAllSources(sql);
        expect(result).toEqual([]);
    });

    it('returns multiple sources ordered by created_at', async () => {
        const second: LiveTvSourceSafeRow = {
            ...exampleSafeRow,
            id: 'second-id',
        };
        const sql = makeSql([exampleSafeRow, second]);
        const result = await getAllSources(sql);
        expect(result).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// getSourceById
// ---------------------------------------------------------------------------

describe('getSourceById', () => {
    it('returns admin row when found', async () => {
        const sql = makeSql([exampleAdminRow]);
        const result = await getSourceById(sql, exampleAdminRow.id);
        expect(result).toEqual(exampleAdminRow);
    });

    it('returns null when not found', async () => {
        const sql = makeSql([]);
        const result = await getSourceById(sql, 'nonexistent-id');
        expect(result).toBeNull();
    });

    it('includes m3u_url and xmltv_url but not xtream_password', async () => {
        const sql = makeSql([exampleAdminRow]);
        const result = await getSourceById(sql, exampleAdminRow.id);
        expect(result).not.toBeNull();
        expect(result!.m3u_url).toBe('http://example.com/playlist.m3u');
        expect(result!.xmltv_url).toBe('http://example.com/epg.xml');
        // xtream_password must not be present on the admin row type
        expect('xtream_password' in (result ?? {})).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// getSourceByIdWithCredentials
// ---------------------------------------------------------------------------

describe('getSourceByIdWithCredentials', () => {
    it('returns full row including xtream_password', async () => {
        const sql = makeSql([exampleXtreamRow]);
        const result = await getSourceByIdWithCredentials(sql, exampleXtreamRow.id);
        expect(result).toEqual({
            ...exampleXtreamRow,
            // This is the one read path that resolves credentials, so it also
            // rebuilds the credentialed fetch URL from them (C8).
            m3u_url:
                'http://xtream.example.com/get.php?username=user123&password=s3cr3t&type=m3u_plus',
        });
        expect(result!.xtream_password).toBe('s3cr3t');
    });

    it('returns null when not found', async () => {
        const sql = makeSql([]);
        const result = await getSourceByIdWithCredentials(sql, 'nonexistent-id');
        expect(result).toBeNull();
    });

    it('includes all credential fields on m3u source', async () => {
        const sql = makeSql([exampleFullRow]);
        const result = await getSourceByIdWithCredentials(sql, exampleFullRow.id);
        expect(result).not.toBeNull();
        expect(result!.m3u_url).toBe('http://example.com/playlist.m3u');
        expect(result!.xtream_password).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// createSource
// ---------------------------------------------------------------------------

describe('createSource', () => {
    it('returns the inserted row', async () => {
        const sql = makeSql([exampleSafeRow]);
        const result = await createSource(sql, {
            name: 'My M3U Source',
            source_type: 'm3u',
            m3u_url: 'http://example.com/playlist.m3u',
        });
        expect(result).toEqual(exampleSafeRow);
    });

    it('throws if INSERT returns no row', async () => {
        const sql = makeSql([]);
        await expect(createSource(sql, { name: 'Test', source_type: 'm3u' })).rejects.toThrow(
            'INSERT livetv_sources returned no row',
        );
    });

    it('creates xtream source with credentials', async () => {
        const xtreamSafe: LiveTvSourceSafeRow = {
            ...exampleSafeRow,
            id: exampleXtreamRow.id,
            name: exampleXtreamRow.name,
            source_type: 'xtream',
        };
        const sql = makeSql([xtreamSafe]);
        const result = await createSource(sql, {
            name: 'Xtream Source',
            source_type: 'xtream',
            xtream_server: 'http://xtream.example.com',
            xtream_username: 'user123',
            xtream_password: 's3cr3t',
        });
        expect(result.source_type).toBe('xtream');
    });
});

// ---------------------------------------------------------------------------
// updateSource
// ---------------------------------------------------------------------------

describe('updateSource', () => {
    it('returns updated row when found', async () => {
        const updated: LiveTvSourceSafeRow = {
            ...exampleSafeRow,
            name: 'Updated Name',
            updated_at: new Date('2026-02-01T00:00:00Z'),
        };
        const sql = makeSql([updated]);
        const result = await updateSource(sql, exampleSafeRow.id, {
            name: 'Updated Name',
        });
        expect(result).toEqual(updated);
    });

    it('returns null when id not found', async () => {
        const sql = makeSql([]);
        const result = await updateSource(sql, 'nonexistent-id', {
            name: 'Whatever',
        });
        expect(result).toBeNull();
    });

    it('preserves all fields when params is empty object', async () => {
        const sql = makeSql([exampleSafeRow]);
        const result = await updateSource(sql, exampleSafeRow.id, {});
        expect(result).toEqual(exampleSafeRow);
    });

    it('updates max_streams independently', async () => {
        const updated: LiveTvSourceSafeRow = {
            ...exampleSafeRow,
            max_streams: 5,
        };
        const sql = makeSql([updated]);
        const result = await updateSource(sql, exampleSafeRow.id, {
            max_streams: 5,
        });
        expect(result!.max_streams).toBe(5);
    });

    it('clears refresh_cron with null', async () => {
        const updated: LiveTvSourceSafeRow = {
            ...exampleSafeRow,
            refresh_cron: null,
        };
        const sql = makeSql([updated]);
        const result = await updateSource(sql, exampleSafeRow.id, {
            refresh_cron: null,
        });
        expect(result!.refresh_cron).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// deleteSource
// ---------------------------------------------------------------------------

describe('deleteSource', () => {
    it('returns true when a row was deleted', async () => {
        const sql = makeSql({ count: 1 });
        const result = await deleteSource(sql, exampleSafeRow.id);
        expect(result.deleted).toBe(true);
    });

    it('returns false when no row was deleted', async () => {
        const sql = makeSql({ count: 0 });
        const result = await deleteSource(sql, 'nonexistent-id');
        expect(result.deleted).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// updateRefreshStatus
// ---------------------------------------------------------------------------

describe('updateRefreshStatus', () => {
    it('returns true when source exists', async () => {
        const sql = makeSql({ count: 1 });
        await expect(
            updateRefreshStatus(sql, exampleSafeRow.id, 'ok', { channels: 150 }),
        ).resolves.toBe(true);
    });

    it('calls sql with the provided status', async () => {
        const sql = makeSql({ count: 1 });
        await updateRefreshStatus(sql, exampleSafeRow.id, 'error', {
            error: 'timeout',
        });
        expect(sql).toHaveBeenCalled();
    });

    it('returns false when source does not exist', async () => {
        const sql = makeSql({ count: 0 });
        await expect(updateRefreshStatus(sql, exampleSafeRow.id, 'ok', null)).resolves.toBe(false);
    });
});

// ---------------------------------------------------------------------------
// getSourceChannelCount
// ---------------------------------------------------------------------------

describe('getSourceChannelCount', () => {
    it('returns channel count as a number', async () => {
        const sql = makeSql([{ count: '42' }]);
        const result = await getSourceChannelCount(sql, exampleSafeRow.id);
        expect(result).toBe(42);
    });

    it('returns 0 when source has no channels', async () => {
        const sql = makeSql([{ count: '0' }]);
        const result = await getSourceChannelCount(sql, exampleSafeRow.id);
        expect(result).toBe(0);
    });

    it('returns 0 when query returns empty (source not found)', async () => {
        const sql = makeSql([]);
        const result = await getSourceChannelCount(sql, 'nonexistent-id');
        expect(result).toBe(0);
    });

    it('parses large counts correctly', async () => {
        const sql = makeSql([{ count: '10000' }]);
        const result = await getSourceChannelCount(sql, exampleSafeRow.id);
        expect(result).toBe(10000);
    });
});

// ---------------------------------------------------------------------------
// Credentials at rest (security review 2026-09-12, C8)
// ---------------------------------------------------------------------------

describe('xtream credentials at rest', () => {
    /**
     * The AAD context a credential is bound to (security review 2026-09-13,
     * C19). Spelled out rather than imported: it is an ON-DISK contract, and
     * changing it orphans every credential already sealed under it.
     */
    const credCtx = (id: string, column: 'xtream_username' | 'xtream_password'): string =>
        `livetv_sources:${id.toLowerCase()}/${column}`;

    const CREDENTIALED_M3U =
        'http://xtream.example.com/get.php?username=user123&password=s3cr3t&type=m3u_plus';
    const CREDENTIALED_XMLTV =
        'http://xtream.example.com/xmltv.php?username=user123&password=s3cr3t';

    it('createSource seals the credentials and binds no credentialed URL', async () => {
        const sql = makeSql([{ ...exampleSafeRow, source_type: 'xtream' }]);
        await createSource(sql, {
            name: 'Xtream Source',
            source_type: 'xtream',
            m3u_url: CREDENTIALED_M3U,
            xmltv_url: CREDENTIALED_XMLTV,
            xtream_server: 'http://xtream.example.com',
            xtream_username: 'user123',
            xtream_password: 's3cr3t',
        });

        const bound = boundStrings(sql);
        const sealed = bound.filter((v) => v.startsWith('enc:v2:'));
        expect(sealed).toHaveLength(2);
        // The credentials are bound to the id the INSERT actually carries, so
        // they can only be opened as that row's own columns.
        const key = deriveMasterKey(TEST_MASTER_KEY);
        const insertedId = bound.find((v) => UUID_RE.test(v));
        expect(insertedId).toBeDefined();
        expect(openSecret(sealed[0], key, credCtx(insertedId!, 'xtream_username'))).toBe('user123');
        expect(openSecret(sealed[1], key, credCtx(insertedId!, 'xtream_password'))).toBe('s3cr3t');
        // …and not as the other column of the same row.
        expect(() => openSecret(sealed[1], key, credCtx(insertedId!, 'xtream_username'))).toThrow();
        for (const value of bound) {
            expect(value).not.toContain('s3cr3t');
            expect(value).not.toContain('user123');
            expect(value).not.toContain('password=');
            expect(value).not.toContain('username=');
        }
        // The bare URL is still stored, so the source stays identifiable/refreshable.
        expect(bound).toContain('http://xtream.example.com/get.php?type=m3u_plus');
    });

    it('updateSource seals the credentials and binds no credentialed URL', async () => {
        const sql = makeSql([exampleSafeRow]);
        await updateSource(sql, exampleSafeRow.id, {
            source_type: 'xtream',
            m3u_url: CREDENTIALED_M3U,
            xmltv_url: CREDENTIALED_XMLTV,
            xtream_username: 'user123',
            xtream_password: 's3cr3t',
        });

        const bound = boundStrings(sql);
        const sealed = bound.filter((v) => v.startsWith('enc:v2:'));
        expect(sealed).toHaveLength(2);
        const key = deriveMasterKey(TEST_MASTER_KEY);
        expect(openSecret(sealed[0], key, credCtx(exampleSafeRow.id, 'xtream_username'))).toBe(
            'user123',
        );
        expect(openSecret(sealed[1], key, credCtx(exampleSafeRow.id, 'xtream_password'))).toBe(
            's3cr3t',
        );
        for (const value of bound) {
            expect(value).not.toContain('s3cr3t');
            expect(value).not.toContain('user123');
            expect(value).not.toContain('password=');
        }
    });

    it('a credential transplanted from another source does not open', async () => {
        // The C19 attack at this layer: copy one source's sealed password into
        // another's row. The read path must fail closed (null → the refresh
        // fails upstream) rather than hand the second source the first's
        // subscription.
        const key = deriveMasterKey(TEST_MASTER_KEY);
        const stolenRow: LiveTvSourceRow = {
            ...exampleXtreamRow,
            xtream_username: sealSecret(
                'user123',
                key,
                credCtx('11111111-1111-4111-8111-111111111111', 'xtream_username'),
            ),
            xtream_password: sealSecret(
                's3cr3t',
                key,
                credCtx('11111111-1111-4111-8111-111111111111', 'xtream_password'),
            ),
        };
        const sql = makeSql([stolenRow]);

        const result = await getSourceByIdWithCredentials(sql, stolenRow.id);
        expect(result!.xtream_username).toBeNull();
        expect(result!.xtream_password).toBeNull();
    });

    it('a non-xtream playlist URL keeps its query string untouched', async () => {
        // Some plain M3U providers legitimately authenticate by query parameter;
        // only an xtream source's URL is rebuilt from sealed credentials.
        const sql = makeSql([exampleSafeRow]);
        await createSource(sql, {
            name: 'Plain M3U',
            source_type: 'm3u',
            m3u_url: 'http://provider.example/playlist.m3u?username=u&password=p',
        });
        expect(boundStrings(sql)).toContain(
            'http://provider.example/playlist.m3u?username=u&password=p',
        );
    });

    it('getSourceByIdWithCredentials opens a sealed row and rebuilds the fetch URLs', async () => {
        const key = deriveMasterKey(TEST_MASTER_KEY);
        const sealedRow: LiveTvSourceRow = {
            ...exampleXtreamRow,
            m3u_url: 'http://xtream.example.com/get.php?type=m3u_plus',
            xmltv_url: 'http://xtream.example.com/xmltv.php',
            // enc:v1: — a row written before C19. It must keep opening.
            xtream_username: sealSecret('user123', key),
            xtream_password: sealSecret('s3cr3t', key),
        };
        const sql = makeSql([sealedRow]);

        const result = await getSourceByIdWithCredentials(sql, sealedRow.id);
        expect(result!.xtream_username).toBe('user123');
        expect(result!.xtream_password).toBe('s3cr3t');
        expect(result!.m3u_url).toContain('username=user123');
        expect(result!.m3u_url).toContain('password=s3cr3t');
        expect(result!.m3u_url).toContain('type=m3u_plus');
        expect(result!.xmltv_url).toContain('password=s3cr3t');
    });

    it('a legacy plaintext row still resolves', async () => {
        // Rows written before sealing carry plaintext credentials and a
        // credentialed URL; both must keep working until the next write re-seals.
        const legacyRow: LiveTvSourceRow = {
            ...exampleXtreamRow,
            m3u_url: CREDENTIALED_M3U,
            xmltv_url: CREDENTIALED_XMLTV,
        };
        const sql = makeSql([legacyRow]);

        const result = await getSourceByIdWithCredentials(sql, legacyRow.id);
        expect(result!.xtream_username).toBe('user123');
        expect(result!.xtream_password).toBe('s3cr3t');
        expect(result!.m3u_url).toContain('password=s3cr3t');
    });

    it('a legacy row with no xtream_server falls back to the stored credentialed URL', async () => {
        const legacyRow: LiveTvSourceRow = {
            ...exampleXtreamRow,
            xtream_server: null,
            m3u_url: CREDENTIALED_M3U,
            xmltv_url: null,
        };
        const sql = makeSql([legacyRow]);

        const result = await getSourceByIdWithCredentials(sql, legacyRow.id);
        expect(result!.m3u_url).toBe(CREDENTIALED_M3U);
        expect(result!.xmltv_url).toBeNull();
    });

    it('getSourceById never hands back a credentialed URL, even for a legacy row', async () => {
        const sql = makeSql([
            {
                ...exampleAdminRow,
                source_type: 'xtream' as const,
                m3u_url: CREDENTIALED_M3U,
                xmltv_url: CREDENTIALED_XMLTV,
            },
        ]);

        const result = await getSourceById(sql, exampleAdminRow.id);
        expect(result!.m3u_url).not.toContain('password=');
        expect(result!.m3u_url).not.toContain('username=');
        expect(result!.m3u_url).toContain('type=m3u_plus');
        expect(result!.xmltv_url).not.toContain('password=');
    });
});
