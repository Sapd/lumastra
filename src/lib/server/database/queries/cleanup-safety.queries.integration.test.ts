// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, mkdir, writeFile, access, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../config.js';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    applyStubMerge,
    findMergeStubCandidates,
    pruneOldPlaySessions,
} from './database-cleanup.queries.js';
import {
    claimUploadSessionForAssembly,
    findExpiredUploadSessions,
} from './upload-sessions.queries.js';
import { evaluateNeverOwnedUnits } from './never-owned-media-gc.queries.js';
import { createCatalogService } from '../../services/catalog.service.js';

const selection = vi.hoisted(() => ({
    afterSelect: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('./upload-sessions.queries.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('./upload-sessions.queries.js')>();
    return {
        ...real,
        findExpiredUploadSessions: async (
            ...args: Parameters<typeof real.findExpiredUploadSessions>
        ) => {
            const rows = await real.findExpiredUploadSessions(...args);
            await selection.afterSelect?.();
            return rows;
        },
    };
});
import { cleanupExpiredUploadSessions } from '../../services/upload-session.service.js';

let sql: postgres.Sql;
beforeAll(() => {
    sql = getTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.all);
});
afterAll(async () => {
    await closeTestDb();
});

async function item(
    type: string,
    parent: string | null = null,
    season: number | null = null,
): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, created_at)
        VALUES (${id}, 'Same title', ${type}, ${parent}, ${season}, NOW() - INTERVAL '60 days')`;
    return id;
}

describe('cleanup safety regressions', () => {
    it('skips the whole stub merge if a conflicting season contains a file-linked episode', async () => {
        const canonical = await item('tv');
        const stub = await item('tv');
        const canonicalSeason = await item('season', canonical, 1);
        const season = await item('season', stub, 1);
        const nonConflict = await item('season', stub, 2);
        const episode = await item('episode', season);
        const canonicalEpisode = await item('episode', canonicalSeason);
        await sql`UPDATE media_items SET episode_number = 1 WHERE id IN (${episode}, ${canonicalEpisode})`;
        const file = randomUUID();
        await sql`INSERT INTO media_files (id, file_path) VALUES (${file}, '/test/linked.mkv')`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file}, ${episode})`;
        await expect(applyStubMerge(sql, stub, canonical)).rejects.toThrow(/file-linked/);
        const rows =
            await sql`SELECT id, parent_id, status FROM media_items WHERE id IN (${stub}, ${season}, ${episode}, ${nonConflict})`;
        expect(rows.every((r) => r.status === 'active')).toBe(true);
        expect(rows.find((r) => r.id === nonConflict)?.parent_id).toBe(stub);
        expect(rows.find((r) => r.id === episode)?.parent_id).toBe(season);
    });

    it('accepts an unknown stub year with exactly one match and rejects conflicting years or identities', async () => {
        const canonical = await item('tv');
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES (${canonical}, 'tmdb', '87654321', 'tv')`;
        await sql`UPDATE media_items SET year = 2020 WHERE id = ${canonical}`;
        const stub = await item('tv');
        const stubSeason = await item('season', stub, 1);
        const canonicalSeason = await item('season', canonical, 1);
        const stubEpisode = await item('episode', stubSeason);
        const canonicalEpisode = await item('episode', canonicalSeason);
        await sql`UPDATE media_items SET season_number = 1, episode_number = 1 WHERE id IN (${stubEpisode},${canonicalEpisode})`;
        expect(await findMergeStubCandidates(sql)).toEqual([
            { stub_id: stub, canonical_id: canonical },
        ]);
        await sql`UPDATE media_items SET year = 1990 WHERE id = ${stub}`;
        expect(await findMergeStubCandidates(sql)).toEqual([]);
        await sql`UPDATE media_items SET year = 2020 WHERE id = ${stub}`;
        expect(await findMergeStubCandidates(sql)).toEqual([
            { stub_id: stub, canonical_id: canonical },
        ]);
        // A scanner assigning a conflicting provider identity removes it from the stub domain.
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES (${stub}, 'tmdb', '87654322', 'tv')`;
        expect(await findMergeStubCandidates(sql)).toEqual([]);
    });

    it('preserves the discovery GC keep stamp through provider refreshes', async () => {
        const id = await item('movie');
        const service = createCatalogService(sql, { skipLifecycleHooks: true });
        const stamp = new Date().toISOString();
        expect(
            (await evaluateNeverOwnedUnits(sql, { limit: 10, minAgeDays: 30, rootId: id }))
                .candidates,
        ).toHaveLength(1);
        await service.storeProviderMetadata(id, 'tmdb', {
            discovery_detail_synced_at: stamp,
            overview: 'old',
            stale_provider_field: 'must disappear',
        });
        await service.storeProviderMetadata(id, 'tmdb', { overview: 'new' });
        const [row] =
            await sql`SELECT metadata FROM provider_metadata WHERE media_id = ${id} AND provider = 'tmdb'`;
        expect(row.metadata).toEqual({ discovery_detail_synced_at: stamp, overview: 'new' });
        expect(
            (await evaluateNeverOwnedUnits(sql, { limit: 10, minAgeDays: 30, rootId: id }))
                .candidates,
        ).toEqual([]);
        const newer = new Date(Date.now() + 1000).toISOString();
        await service.storeProviderMetadata(id, 'tmdb', { discovery_detail_synced_at: newer });
        const [updated] =
            await sql`SELECT metadata FROM provider_metadata WHERE media_id = ${id} AND provider = 'tmdb'`;
        expect(updated.metadata.discovery_detail_synced_at).toBe(newer);
        await service.storeProviderMetadata(id, 'tmdb', {
            discovery_detail_synced_at: stamp,
            overview: 'latest payload',
        });
        const [older] =
            await sql`SELECT metadata FROM provider_metadata WHERE media_id = ${id} AND provider = 'tmdb'`;
        expect(older.metadata).toEqual({
            discovery_detail_synced_at: newer,
            overview: 'latest payload',
        });
    });

    it.each([false, true])(
        'moves non-clashing episodes out of a conflicting season, preserving history/files=%s',
        async (referenced) => {
            const canonical = await item('tv');
            const stub = await item('tv');
            const canonicalSeason = await item('season', canonical, 1);
            const season = await item('season', stub, 1);
            const episode = await item('episode', season);
            await sql`UPDATE media_items SET episode_number = 2 WHERE id = ${episode}`;
            if (referenced) {
                const user = randomUUID();
                const file = randomUUID();
                await sql`INSERT INTO users (id, username) VALUES (${user}, ${user})`;
                await sql`INSERT INTO watch_history (media_id, user_id, media_type, session_start_time) VALUES (${episode}, ${user}, 'episode', NOW())`;
                await sql`INSERT INTO media_files (id, file_path) VALUES (${file}, '/test/moving.mkv')`;
                await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file}, ${episode})`;
            }

            await applyStubMerge(sql, stub, canonical);
            const [moved] =
                await sql`SELECT parent_id, status FROM media_items WHERE id = ${episode}`;
            expect(moved).toMatchObject({ parent_id: canonicalSeason, status: 'active' });
            if (referenced) {
                const flags =
                    await sql`SELECT has_files FROM media_items WHERE id IN (${canonicalSeason},${canonical})`;
                expect(flags.every((r) => r.has_files)).toBe(true);
                expect(
                    await sql`SELECT 1 FROM watch_history WHERE media_id = ${episode}`,
                ).toHaveLength(1);
                expect(
                    await sql`SELECT 1 FROM media_file_items WHERE media_item_id = ${episode}`,
                ).toHaveLength(1);
            }
            const broken =
                await sql`SELECT child.id FROM media_items child JOIN media_items parent ON parent.id = child.parent_id WHERE child.status = 'active' AND parent.status = 'deleted'`;
            expect(broken).toEqual([]);
        },
    );

    it('aborts a clashing episode merge with watch history, preserving the whole stub', async () => {
        const canonical = await item('tv');
        const stub = await item('tv');
        const canonicalSeason = await item('season', canonical, 1);
        const season = await item('season', stub, 1);
        const episode = await item('episode', season);
        const existing = await item('episode', canonicalSeason);
        await sql`UPDATE media_items SET episode_number = 1 WHERE id IN (${episode}, ${existing})`;
        const user = randomUUID();
        await sql`INSERT INTO users (id, username) VALUES (${user}, ${user})`;
        await sql`INSERT INTO watch_history (media_id, user_id, media_type, session_start_time) VALUES (${episode}, ${user}, 'episode', NOW())`;
        await expect(applyStubMerge(sql, stub, canonical)).rejects.toThrow(/Skipping stub merge/);
        const rows =
            await sql`SELECT id, status, parent_id FROM media_items WHERE id IN (${stub}, ${season}, ${episode})`;
        expect(rows.every((r) => r.status === 'active')).toBe(true);
        expect(rows.find((r) => r.id === episode)?.parent_id).toBe(season);
        expect(await sql`SELECT 1 FROM watch_history WHERE media_id = ${episode}`).toHaveLength(1);
    });

    it('does not merge a null-year stub with an ambiguous normalized title', async () => {
        const stub = await item('tv');
        await item('season', stub, 1);
        for (const year of [2020, 2021]) {
            const canonical = await item('tv');
            await sql`UPDATE media_items SET year = ${year} WHERE id = ${canonical}`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${canonical}, 'tmdb', ${String(year)}, 'tv')`;
        }
        expect(await findMergeStubCandidates(sql)).toEqual([]);
    });

    it.each(['active', 'deleted', 'merged'])(
        'rejects a null-year title match when another root in %s status has a different year',
        async (status) => {
            const canonical = await item('tv');
            const stub = await item('tv');
            await sql`UPDATE media_items SET year=2005 WHERE id=${canonical}`;
            await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${canonical},'tmdb','12345','tv')`;
            const canonicalSeason = await item('season', canonical, 1);
            const stubSeason = await item('season', stub, 1);
            const existing = await item('episode', canonicalSeason);
            const episode = await item('episode', stubSeason);
            await sql`UPDATE media_items SET season_number=1, episode_number=1 WHERE id IN (${existing},${episode})`;
            const other = await item('tv');
            await sql`UPDATE media_items SET year=2001,status=${status} WHERE id=${other}`;
            expect(await findMergeStubCandidates(sql)).toEqual([]);
        },
    );

    it('rejects a null-year title-only match without overlapping season/episode numbers', async () => {
        const canonical = await item('tv');
        const stub = await item('tv');
        await sql`UPDATE media_items SET year=2005 WHERE id=${canonical}`;
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${canonical},'tmdb','12345','tv')`;
        const canonicalSeason = await item('season', canonical, 1);
        const stubSeason = await item('season', stub, 1);
        const existing = await item('episode', canonicalSeason);
        const episode = await item('episode', stubSeason);
        await sql`UPDATE media_items SET episode_number=2 WHERE id=${existing}`;
        await sql`UPDATE media_items SET episode_number=1 WHERE id=${episode}`;
        expect(await findMergeStubCandidates(sql)).toEqual([]);
    });

    it.each([false, true])(
        'handles a deleted canonical season without 23505 (protected stub=%s)',
        async (protectedChild) => {
            const canonical = await item('tv');
            const stub = await item('tv');
            const canonicalSeason = await item('season', canonical, 1);
            const season = await item('season', stub, 1);
            const episode = await item('episode', season);
            await sql`UPDATE media_items SET status='deleted' WHERE id=${canonicalSeason}`;
            if (protectedChild) {
                const user = randomUUID();
                await sql`INSERT INTO users (id,username) VALUES (${user},${user})`;
                await sql`INSERT INTO watch_history (media_id,user_id,media_type,session_start_time) VALUES (${episode},${user},'episode',NOW())`;
                await expect(applyStubMerge(sql, stub, canonical)).rejects.toThrow(
                    /Skipping stub merge/,
                );
            } else await applyStubMerge(sql, stub, canonical);
            const rows =
                await sql`SELECT status FROM media_items WHERE id IN (${stub},${season},${episode})`;
            expect(rows.every((r) => r.status === (protectedChild ? 'active' : 'deleted'))).toBe(
                true,
            );
            const broken =
                await sql`SELECT child.id FROM media_items child JOIN media_items parent ON child.parent_id=parent.id WHERE child.status='active' AND parent.status='deleted'`;
            expect(broken).toEqual([]);
        },
    );

    it.each([false, true])(
        'handles a deleted canonical episode without 23505 (protected stub=%s)',
        async (protectedChild) => {
            const canonical = await item('tv');
            const stub = await item('tv');
            const canonicalSeason = await item('season', canonical, 1);
            const season = await item('season', stub, 1);
            const existing = await item('episode', canonicalSeason);
            const episode = await item('episode', season);
            await sql`UPDATE media_items SET season_number=1,episode_number=1 WHERE id IN (${existing},${episode})`;
            await sql`UPDATE media_items SET status='deleted' WHERE id=${existing}`;
            if (protectedChild) {
                const user = randomUUID();
                await sql`INSERT INTO users (id,username) VALUES (${user},${user})`;
                await sql`INSERT INTO watch_history (media_id,user_id,media_type,session_start_time) VALUES (${episode},${user},'episode',NOW())`;
                await expect(applyStubMerge(sql, stub, canonical)).rejects.toThrow(
                    /Skipping stub merge/,
                );
            } else await applyStubMerge(sql, stub, canonical);
            const [row] = await sql`SELECT status,parent_id FROM media_items WHERE id=${episode}`;
            expect(row).toMatchObject({
                status: protectedChild ? 'active' : 'deleted',
                parent_id: season,
            });
        },
    );

    it.each(['scan', 'reparent'])(
        'locks both merge trees in UUID order while a concurrent %s holds a leaf',
        async (mode) => {
            const canonical = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
            const stub = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
            const season = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
            const episode = '00000000-0000-4000-8000-000000000001';
            await sql`INSERT INTO media_items (id,title,media_type) VALUES (${canonical},'Lock order','tv'),(${stub},'Lock order','tv')`;
            await sql`INSERT INTO media_items (id,title,media_type,parent_id,season_number) VALUES (${season},'Season','season',${canonical},1)`;
            await sql`INSERT INTO media_items (id,title,media_type,parent_id,season_number,episode_number) VALUES (${episode},'Episode','episode',${season},1,1)`;
            await item('season', stub, 2);
            const outside = mode === 'reparent' ? await item('tv') : null;
            const scanner = postgres(getTestDatabaseUrl(), { max: 1 });
            const merger = postgres(getTestDatabaseUrl(), { max: 1 });
            const [{ pid: scannerPid }] = await scanner<
                { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            const [{ pid: mergerPid }] = await merger<
                { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            let releaseScanner!: () => void;
            let signalLocked!: () => void;
            const released = new Promise<void>((resolve) => {
                releaseScanner = resolve;
            });
            const locked = new Promise<void>((resolve) => {
                signalLocked = resolve;
            });
            const scanning = scanner
                .begin(async (tx) => {
                    await tx`SELECT id FROM media_items WHERE id=${episode} FOR NO KEY UPDATE`;
                    signalLocked();
                    await released;
                    if (outside) {
                        await tx`UPDATE media_items SET parent_id = ${outside} WHERE id = ${episode}`;
                    } else {
                        await tx`SELECT id FROM media_items WHERE id=${canonical} FOR NO KEY UPDATE`;
                    }
                })
                .then(
                    () => null,
                    (err) => err,
                );
            await locked;
            const merging = applyStubMerge(merger, stub, canonical).then(
                () => null,
                (err) => err,
            );
            try {
                await vi.waitFor(
                    async () => {
                        const [{ blocking }] = await sql<
                            { blocking: number[] }[]
                        >`SELECT pg_blocking_pids(${mergerPid}::int) AS blocking`;
                        expect(blocking).toContain(scannerPid);
                    },
                    { timeout: 5000 },
                );
                releaseScanner();
                expect(await scanning).toBeNull();
                const result = await merging;
                if (outside) {
                    expect(result).toBeInstanceOf(Error);
                    expect((result as Error).message).toMatch(
                        /Skipping stub merge.*hierarchy changed/,
                    );
                    const [row] = await sql`SELECT status FROM media_items WHERE id = ${stub}`;
                    expect(row.status).toBe('active');
                    const [moved] =
                        await sql`SELECT parent_id FROM media_items WHERE id = ${episode}`;
                    expect(moved.parent_id).toBe(outside);
                } else expect(result).toBeNull();
            } finally {
                releaseScanner();
                await Promise.all([scanning, merging]);
                await Promise.all([scanner.end(), merger.end()]);
            }
        },
    );

    async function upload(status: string, hoursAgo: number): Promise<string> {
        const group = randomUUID();
        const path = randomUUID();
        const id = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${group}, ${group})`;
        await sql`INSERT INTO library_paths (id, path, media_type, library_group_id)
            VALUES (${path}, ${'/test/' + id}, 'movie', ${group})`;
        await sql`INSERT INTO upload_sessions (id, library_path_id, uploader_user, filename, mime_type,
            total_size, total_chunks, staging_dir, status, expires_at, updated_at)
            VALUES (${id}, ${path}, 'uploader', 'movie.mkv', 'video/x-matroska', 10, 1,
            ${'/staging/' + id}, ${status}, NOW() - INTERVAL '1 hour',
            NOW() - MAKE_INTERVAL(hours => ${hoursAgo}))`;
        return id;
    }

    it('protects an active assembly but collects abandoned assemblies and terminal uploads', async () => {
        const live = await upload('assembling', 1);
        const dead = await upload('assembling', 7);
        const others = [];
        for (const status of ['uploading', 'queued', 'failed', 'aborted'])
            others.push(await upload(status, 1));
        const ids = (await findExpiredUploadSessions(sql, new Date())).map((r) => r.id);
        expect(ids).not.toContain(live);
        expect(ids.sort()).toEqual([dead, ...others].sort());
    });

    it('extends the expiry when claiming an upload for assembly', async () => {
        const id = await upload('uploading', 1);
        expect(await claimUploadSessionForAssembly(sql, id)).toBe(true);
        const [row] = await sql`SELECT expires_at FROM upload_sessions WHERE id = ${id}`;
        expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 5.9 * 60 * 60 * 1000);
        expect(await claimUploadSessionForAssembly(sql, id)).toBe(false);
    });

    it('does not remove staging when an assembly claim wins after the sweep selected an expired upload', async () => {
        const id = await upload('uploading', 1);
        const staging = await mkdtemp(join(tmpdir(), 'upload-gc-race-'));
        const chunk = join(staging, 'chunk-0');
        await writeFile(chunk, 'chunk');
        await sql`UPDATE upload_sessions SET staging_dir = ${staging} WHERE id = ${id}`;
        selection.afterSelect = async () => {
            expect(await claimUploadSessionForAssembly(sql, id)).toBe(true);
        };
        try {
            expect(await cleanupExpiredUploadSessions(sql)).toBe(0);
            await expect(access(chunk)).resolves.toBeUndefined();
            const [row] = await sql`SELECT status FROM upload_sessions WHERE id = ${id}`;
            expect(row?.status).toBe('assembling');
        } finally {
            selection.afterSelect = undefined;
            await rm(staging, { recursive: true, force: true });
        }
    });

    it.each([true, false])(
        'sweeps only contained old rowless staging directories (override=%s)',
        async (override) => {
            const root = await mkdtemp(join(tmpdir(), 'upload-orphan-'));
            const outside = await mkdtemp(join(tmpdir(), 'upload-outside-'));
            const staging = join(root, override ? 'staging' : '.upload-staging');
            await mkdir(staging);
            const live = await upload('assembling', 1);
            await sql`UPDATE library_paths SET path = ${root} WHERE id = (SELECT library_path_id FROM upload_sessions WHERE id = ${live})`;
            const names = [randomUUID(), randomUUID(), live, 'shared-backups'];
            for (const name of names) {
                const path = join(staging, name);
                await mkdir(path);
                await writeFile(join(path, 'chunk-0'), 'chunk');
                await utimes(path, new Date(0), new Date(0));
            }
            await utimes(join(staging, names[1]), new Date(), new Date());
            await sql`UPDATE upload_sessions SET staging_dir = ${join(staging, live)} WHERE id = ${live}`;
            const link = join(staging, randomUUID());
            await writeFile(join(outside, 'keep'), 'outside');
            await utimes(outside, new Date(0), new Date(0));
            await symlink(outside, link);
            const spy = vi
                .spyOn(config, 'UPLOAD_STAGING_DIR', 'get')
                .mockReturnValue(override ? staging : '');
            try {
                await cleanupExpiredUploadSessions(sql);
                await expect(access(join(staging, names[0]))).rejects.toThrow();
                for (const name of names.slice(1))
                    await expect(access(join(staging, name, 'chunk-0'))).resolves.toBeUndefined();
                await expect(access(join(outside, 'keep'))).resolves.toBeUndefined();
            } finally {
                spy.mockRestore();
                await rm(root, { recursive: true, force: true });
                await rm(outside, { recursive: true, force: true });
            }
        },
    );

    it('prunes old KILLED sessions using the same retention as other terminal states', async () => {
        const media = await item('movie');
        const user = randomUUID();
        await sql`INSERT INTO users (id, username) VALUES (${user}, ${user})`;
        const kept = [];
        for (const status of ['KILLED', 'COMPLETED', 'CRASHED', 'ACTIVE', 'PAUSED']) {
            for (const old of [true, false]) {
                const id = randomUUID();
                await sql`INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address,
                    play_method, status, stopped_at) VALUES (${id}, ${media}, ${user}, 'device',
                    '127.0.0.1', 'direct', ${status}, NOW() - MAKE_INTERVAL(days => ${old ? 60 : 1}))`;
                if (!old || status === 'ACTIVE' || status === 'PAUSED') kept.push(id);
            }
        }
        expect(await pruneOldPlaySessions(sql, new Date(Date.now() - 30 * 86400000))).toBe(3);
        const rows = await sql`SELECT id FROM play_sessions`;
        expect(rows.map((r) => r.id).sort()).toEqual(kept.sort());
    });
});
