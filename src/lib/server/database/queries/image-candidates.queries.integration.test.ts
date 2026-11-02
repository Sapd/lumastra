// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    registerImageCandidate,
    listImageCandidates,
    getSelectedImageCandidate,
    updateImageSelectionPolicy,
    registerPersonImageCandidate,
} from './image-candidates.queries.js';
import { upsertProviderMetadataUnlessLocked } from './media-upsert.js';
import { resolvePersonImageSet } from '$lib/server/services/image-descriptor/people.js';
import { invalidateFileProbeData } from './media-files.queries.js';
import { remapEpisodeThumbnailPath } from './media-artwork.queries.js';
import { upsertLocalArtwork } from './media-artwork.queries.js';
import { mutateImageCandidates } from '$lib/server/services/image-candidates.service.js';
import { resolveImageSet } from '$lib/server/services/image-descriptor/resolver.js';
import { DEFAULT_IMAGE_CANDIDATE_ORDER } from '$lib/shared/image-provenance.js';
vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => ({ invalidateCatalogImage: vi.fn() }),
}));

describe('image candidates database', () => {
    let sql: postgres.Sql;
    const ids: string[] = [];
    const fileIds: string[] = [];
    beforeAll(() => {
        sql = getTestDb();
    });
    afterEach(async () => {
        await sql`DELETE FROM image_provider_suppressions WHERE owner = ANY(${ids}::text[]) OR owner = 'tmdb:987654321'`;
        await sql`DELETE FROM audit_log WHERE target = ANY(${ids}::text[])`;
        await sql`DELETE FROM media_items WHERE id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM image_candidates WHERE person_ref = 'tmdb:987654321'`;
        await sql`DELETE FROM person_image_owners WHERE person_ref = 'tmdb:987654321'`;
        await sql`DELETE FROM audit_log WHERE target = 'tmdb:987654321'`;
        if (fileIds.length) await sql`DELETE FROM media_files WHERE id = ANY(${fileIds}::uuid[])`;
        fileIds.length = 0;
        ids.length = 0;
        await updateImageSelectionPolicy(sql, DEFAULT_IMAGE_CANDIDATE_ORDER, 'provider');
    });
    afterAll(async () => {
        await closeTestDb();
    });
    async function item(type = 'movie'): Promise<string> {
        const id = randomUUID();
        ids.push(id);
        await sql`INSERT INTO media_items (id, title, media_type) VALUES (${id}, ${`Provenance ${id}`}, ${type})`;
        return id;
    }
    it('selects and retains a new admin-extracted thumbnail over a locked previous choice', async () => {
        const id = await item('episode');
        await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'thumb',
            provider: 'tmdb',
            providerRef: '/previous.jpg',
            remoteUrl: 'https://image.tmdb.org/t/p/original/previous.jpg',
        });
        await sql`UPDATE image_candidates SET locked=true,chosen_by='admin' WHERE media_item_id=${id}`;
        const path = `/frames/${id}-${randomUUID()}-thumb.jpg`;
        expect(
            await upsertLocalArtwork(sql, {
                mediaItemId: id,
                artworkType: 'thumb',
                filePath: path,
                sourceTag: 'generated:ffmpeg',
                chosenBy: 'admin',
                provider: 'frame-extract',
            }),
        ).toBe(true);
        const rows = await listImageCandidates(sql, id);
        expect(rows.filter((c) => c.selected)).toHaveLength(1);
        expect(rows.find((c) => c.selected)).toMatchObject({
            file_path: path,
            provider: 'frame-extract',
            chosen_by: 'admin',
        });
        await sql`SELECT reselect_image_candidates(${id}::uuid,'thumb')`;
        expect((await listImageCandidates(sql, id)).find((c) => c.selected)?.file_path).toBe(path);
    });

    it('captures custom URL and metadata writers, without downloading candidates', async () => {
        const id = await item('album');
        await sql`UPDATE media_items SET custom_poster_url = 'https://i.discogs.com/cover.jpg' WHERE id = ${id}`;
        await upsertProviderMetadataUnlessLocked(sql, id, 'tmdb', {
            poster_path: '/a.jpg',
            images: {
                posters: [{ file_path: '/b.jpg', width: 500, height: 750, iso_639_1: 'de' }],
            },
        });
        const candidates = await listImageCandidates(sql, id);
        expect(candidates).toHaveLength(3);
        expect(candidates.every((c) => c.file_path === null)).toBe(true);
        expect(candidates.find((c) => c.provider_ref === '/b.jpg')).toMatchObject({
            provider: 'tmdb',
            width: 500,
            height: 750,
            language: 'de',
        });
        expect((await getSelectedImageCandidate(sql, id, 'poster'))?.provider).toBe('tmdb');
    });
    it('records folder, embedded, upload, provider and frame writers', async () => {
        const id = await item('episode');
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'poster',
            filePath: '/library/folder.jpg',
        });
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'poster',
            filePath: '/config/embedded.jpg',
            provider: 'embedded',
        });
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'backdrop',
            filePath: '/config/frame.jpg',
            sourceTag: 'generated:ffmpeg',
        });
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'logo',
            filePath: '/config/upload.png',
            sourceTag: 'admin:file',
        });
        expect((await listImageCandidates(sql, id)).map((c) => c.provider)).toEqual(
            expect.arrayContaining(['local-folder', 'embedded', 'frame-extract', 'upload']),
        );
        expect(await getSelectedImageCandidate(sql, id, 'thumb')).toMatchObject({
            provider: 'frame-extract',
        });
        expect(await getSelectedImageCandidate(sql, id, 'logo')).toMatchObject({
            chosen_by: 'admin',
            locked: true,
        });
    });
    it('preserves locks, audits curation, rejects stale deletion previews and reselects', async () => {
        const id = await item();
        const tmdb = await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'poster',
            provider: 'tmdb',
            providerRef: '/a.jpg',
        });
        const discogs = await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'poster',
            provider: 'discogs',
            providerRef: 'https://i.discogs.com/a.jpg',
            filePath: '/locked-discogs.jpg',
        });
        await mutateImageCandidates(
            sql,
            id,
            { action: 'select', candidateId: discogs!, locked: true },
            'denis',
        );
        await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'poster',
            provider: 'discogs',
            providerRef: 'https://i.discogs.com/a.jpg',
            filePath: '/replacement.jpg',
        });
        expect((await getSelectedImageCandidate(sql, id, 'poster'))?.file_path).toBe(
            '/locked-discogs.jpg',
        );
        await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'poster',
            provider: 'local-folder',
            providerRef: '/folder.jpg',
            filePath: '/folder.jpg',
        });
        expect((await getSelectedImageCandidate(sql, id, 'poster'))?.id).toBe(discogs);
        const preview = await mutateImageCandidates(
            sql,
            id,
            { action: 'delete-provider', provider: 'discogs', mode: 'preview' },
            'denis',
        );
        expect(preview.candidates.map((c) => c.id)).toEqual([discogs]);
        await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'logo',
            provider: 'tmdb',
            providerRef: '/logo.png',
        });
        await expect(
            mutateImageCandidates(
                sql,
                id,
                {
                    action: 'delete-provider',
                    provider: 'discogs',
                    mode: 'apply',
                    fingerprint: preview.fingerprint,
                },
                'denis',
            ),
        ).rejects.toThrow('Preview again');
        const fresh = await mutateImageCandidates(
            sql,
            id,
            { action: 'delete-provider', provider: 'discogs', mode: 'preview' },
            'denis',
        );
        await mutateImageCandidates(
            sql,
            id,
            {
                action: 'delete-provider',
                provider: 'discogs',
                mode: 'apply',
                fingerprint: fresh.fingerprint,
            },
            'denis',
        );
        expect((await getSelectedImageCandidate(sql, id, 'poster'))?.provider).toBe('local-folder');
        expect(
            await sql`SELECT 1 FROM audit_log WHERE target=${id} AND source='admin'`,
        ).toHaveLength(2);
        expect((await listImageCandidates(sql, id)).some((c) => c.id === tmdb)).toBe(true);
    });
    it('enforces provider-first episode stills and optional generated-first preference', async () => {
        const id = await item('episode');
        await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'thumb',
            provider: 'frame-extract',
            providerRef: '/frame.jpg',
            filePath: '/frame.jpg',
        });
        await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'thumb',
            provider: 'tmdb',
            providerRef: '/still.jpg',
        });
        expect((await getSelectedImageCandidate(sql, id, 'thumb'))?.provider).toBe('tmdb');
        await updateImageSelectionPolicy(sql, DEFAULT_IMAGE_CANDIDATE_ORDER, 'generated');
        expect((await getSelectedImageCandidate(sql, id, 'thumb'))?.provider).toBe('frame-extract');
    });
    it('descriptor exposes selected provenance for all catalog image types', async () => {
        for (const type of ['movie', 'tv', 'season', 'episode', 'album', 'artist', 'audiobook']) {
            const id = await item(type);
            await registerImageCandidate(sql, {
                mediaItemId: id,
                role: 'poster',
                provider: 'tmdb',
                providerRef: '/cover.jpg',
                width: 500,
                height: 750,
            });
            const images = await resolveImageSet(sql, 'v1', id);
            expect(images.poster ?? images.primary).toMatchObject({
                provider: 'tmdb',
                width: 500,
                height: 750,
            });
        }
    });
    it('keeps a locked frame through automated remapping and file-probe invalidation', async () => {
        const id = await item('episode');
        const candidate = await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'thumb',
            provider: 'frame-extract',
            providerRef: '/locked-frame.jpg',
            filePath: '/locked-frame.jpg',
        });
        await mutateImageCandidates(
            sql,
            id,
            { action: 'select', candidateId: candidate!, locked: true },
            'denis',
        );
        expect(await remapEpisodeThumbnailPath(sql, id, '/automatic-frame.jpg')).toBe(0);
        const [file] = await sql<
            { id: string }[]
        >`INSERT INTO media_files (file_path) VALUES (${'/imgprov-' + randomUUID() + '.mkv'}) RETURNING id`;
        fileIds.push(file.id);
        await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${file.id},${id},true)`;
        await invalidateFileProbeData(sql, file.id);
        expect(await getSelectedImageCandidate(sql, id, 'thumb')).toMatchObject({
            id: candidate,
            file_path: '/locked-frame.jpg',
            locked: true,
        });
    });
    it('orders backdrop selections by provider policy and reselects after provider removal', async () => {
        const id = await item();
        const provider = await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'backdrop',
            provider: 'tmdb',
            providerRef: '/tmdb.jpg',
        });
        const local = await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'backdrop',
            provider: 'local-folder',
            providerRef: '/folder.jpg',
            filePath: '/folder.jpg',
        });
        expect((await getSelectedImageCandidate(sql, id, 'backdrop', 0))?.id).toBe(local);
        expect((await getSelectedImageCandidate(sql, id, 'backdrop', 1))?.provider).toBe('tmdb');
        // Local-folder precedence must outrank a conflicting display sort_order.
        await sql`UPDATE image_candidates SET sort_order = CASE WHEN id = ${local} THEN 90 ELSE 0 END
            WHERE media_item_id = ${id} AND artwork_type = 'backdrop' AND selected`;
        const canonical = [
            await getSelectedImageCandidate(sql, id, 'backdrop', 0),
            await getSelectedImageCandidate(sql, id, 'backdrop', 1),
        ];
        const selectedByProjection = (await listImageCandidates(sql, id, 'backdrop')).filter(
            (candidate) => candidate.selected,
        );
        expect(canonical.map((candidate) => candidate?.id)).toEqual([local, provider]);
        expect(selectedByProjection.map((candidate) => candidate.id)).toEqual(
            canonical.map((candidate) => candidate?.id),
        );
        expect(selectedByProjection.map((candidate) => candidate.selection_order)).toEqual([0, 1]);
        expect(selectedByProjection.map((candidate) => candidate.sort_order)).toEqual([90, 0]);
        await mutateImageCandidates(
            sql,
            id,
            { action: 'select', candidateId: local!, locked: true },
            'denis',
        );
        await mutateImageCandidates(
            sql,
            id,
            { action: 'select', candidateId: provider!, locked: true },
            'denis',
        );
        const selected = (await listImageCandidates(sql, id, 'backdrop')).filter((c) => c.selected);
        expect(selected.filter((c) => c.locked)).toHaveLength(2);
    });
    it('curates people in the same candidate table without fabricating catalog rows', async () => {
        const first = await registerPersonImageCandidate(sql, '987654321', '/first.jpg');
        await mutateImageCandidates(
            sql,
            'tmdb:987654321',
            { action: 'select', candidateId: first!, locked: true },
            'denis',
        );
        await registerPersonImageCandidate(sql, '987654321', '/second.jpg');
        expect(await getSelectedImageCandidate(sql, 'tmdb:987654321', 'poster')).toMatchObject({
            id: first,
            provider: 'tmdb',
            locked: true,
        });
        const preview = await mutateImageCandidates(
            sql,
            'tmdb:987654321',
            { action: 'delete-provider', provider: 'tmdb', mode: 'preview' },
            'denis',
        );
        expect(preview.candidates).toHaveLength(2);
        await mutateImageCandidates(
            sql,
            'tmdb:987654321',
            {
                action: 'delete-provider',
                provider: 'tmdb',
                mode: 'apply',
                fingerprint: preview.fingerprint,
            },
            'denis',
        );
        expect(
            (await listImageCandidates(sql, 'tmdb:987654321')).every(
                (candidate) => candidate.suppressed && !candidate.selected,
            ),
        ).toBe(true);
        expect(await resolvePersonImageSet(sql, 'v1', 'tmdb:987654321', '/first.jpg')).toEqual({});
    });
    it('old writer conflict inference and new local writes survive application rollback', async () => {
        const id = await item();
        for (const file of ['/old-a.jpg', '/old-b.jpg']) {
            await sql`INSERT INTO media_artwork (media_item_id,artwork_type,source,file_path,language)
                VALUES (${id},'poster','local',${file},'')
                ON CONFLICT (media_item_id,artwork_type,source,COALESCE(language,'')) DO UPDATE SET file_path = EXCLUDED.file_path`;
        }
        expect((await listImageCandidates(sql, id)).map((c) => c.file_path)).toContain(
            '/old-b.jpg',
        );
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'logo',
            filePath: '/new-logo.jpg',
            sourceTag: 'admin:file',
        });
        const [legacy] =
            await sql`SELECT file_path FROM media_artwork WHERE media_item_id = ${id} AND artwork_type = 'logo'`;
        expect(legacy.file_path).toBe('/new-logo.jpg');
    });
    it('hides all matching references without deleting provider metadata', async () => {
        const id = await item();
        await sql`UPDATE media_items SET custom_poster_url = 'https://image.tmdb.org/t/p/original/a.jpg',
            custom_backdrop_url = 'https://image.tmdb.org/t/p/original/b.jpg' WHERE id = ${id}`;
        await sql`INSERT INTO provider_metadata (media_id,provider,metadata) VALUES (${id},'tmdb',
            ${sql.json({ poster_path: '/a.jpg', backdrop_path: '/b.jpg', images: { backdrops: [{ file_path: '/c.jpg' }] } })})`;
        const preview = await mutateImageCandidates(
            sql,
            id,
            { action: 'delete-provider', provider: 'tmdb', mode: 'preview' },
            'admin',
        );
        await mutateImageCandidates(
            sql,
            id,
            {
                action: 'delete-provider',
                provider: 'tmdb',
                mode: 'apply',
                fingerprint: preview.fingerprint,
            },
            'admin',
        );
        expect(
            (await listImageCandidates(sql, id)).every(
                (candidate) => candidate.suppressed && !candidate.selected,
            ),
        ).toBe(true);
        const [media] =
            await sql`SELECT custom_poster_url,custom_backdrop_url FROM media_items WHERE id = ${id}`;
        expect(media).toMatchObject({
            custom_poster_url: 'https://image.tmdb.org/t/p/original/a.jpg',
            custom_backdrop_url: 'https://image.tmdb.org/t/p/original/b.jpg',
        });
        const [meta] =
            await sql`SELECT metadata FROM provider_metadata WHERE media_id = ${id} AND provider = 'tmdb'`;
        expect(meta.metadata).toEqual({
            poster_path: '/a.jpg',
            backdrop_path: '/b.jpg',
            images: { backdrops: [{ file_path: '/c.jpg' }] },
        });
    });
    it('binds deletion previews to owner, provider, role and snapshot', async () => {
        const id = await item();
        await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'poster',
            provider: 'tmdb',
            providerRef: '/p.jpg',
        });
        await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'backdrop',
            provider: 'tmdb',
            providerRef: '/b.jpg',
        });
        const preview = await mutateImageCandidates(
            sql,
            id,
            { action: 'delete-provider', provider: 'tmdb', role: 'poster', mode: 'preview' },
            'admin',
        );
        for (const [owner, provider, role] of [
            [id, 'tmdb', undefined],
            [id, 'tvdb', 'poster'],
            [await item(), 'tmdb', 'poster'],
        ] as const) {
            await expect(
                mutateImageCandidates(
                    sql,
                    owner,
                    {
                        action: 'delete-provider',
                        provider,
                        role,
                        mode: 'apply',
                        fingerprint: preview.fingerprint,
                    },
                    'admin',
                ),
            ).rejects.toThrow('Preview again');
        }
        expect(await listImageCandidates(sql, id)).toHaveLength(2);
        const emptyA = await item();
        const emptyB = await item();
        const emptyPreview = await mutateImageCandidates(
            sql,
            emptyA,
            { action: 'delete-provider', provider: 'tmdb', mode: 'preview' },
            'admin',
        );
        await expect(
            mutateImageCandidates(
                sql,
                emptyB,
                {
                    action: 'delete-provider',
                    provider: 'tmdb',
                    mode: 'apply',
                    fingerprint: emptyPreview.fingerprint,
                },
                'admin',
            ),
        ).rejects.toThrow('Preview again');
    });
    it('refreshes an active person reference while preserving locks and deletion suppression', async () => {
        const handle = 'tmdb:987654321';
        const first = await resolvePersonImageSet(sql, 'v1', handle, '/first.jpg');
        const next = await resolvePersonImageSet(sql, 'v1', handle, '/next.jpg');
        expect(next.primary?.revision).not.toBe(first.primary?.revision);
        expect((await getSelectedImageCandidate(sql, handle, 'poster'))?.provider_ref).toBe(
            '/next.jpg',
        );
        const again = await resolvePersonImageSet(sql, 'v1', handle, '/first.jpg');
        expect(again.primary?.revision).toBe(first.primary?.revision);
        const selected = await getSelectedImageCandidate(sql, handle, 'poster');
        expect(selected?.provider_ref).toBe('/first.jpg');
        await mutateImageCandidates(
            sql,
            handle,
            { action: 'select', candidateId: selected!.id, locked: true },
            'admin',
        );
        await resolvePersonImageSet(sql, 'v1', handle, '/next.jpg');
        expect((await getSelectedImageCandidate(sql, handle, 'poster'))?.id).toBe(selected!.id);
    });
    it('resumes a policy election after a later batch fails', async () => {
        const owners: string[] = [];
        for (let i = 0; i < 105; i++) {
            const id = await item();
            owners.push(id);
            await registerImageCandidate(sql, {
                mediaItemId: id,
                role: 'poster',
                provider: 'tmdb',
                providerRef: '/t.jpg',
            });
            await registerImageCandidate(sql, {
                mediaItemId: id,
                role: 'poster',
                provider: 'tvdb',
                providerRef: '/v.jpg',
            });
        }
        owners.sort();
        // A table-backed failure condition is visible on every pooled connection.
        await sql`CREATE TABLE test_image_policy_fail_owner (id uuid PRIMARY KEY)`;
        await sql`INSERT INTO test_image_policy_fail_owner VALUES (${owners.at(-1)!})`;
        await sql`CREATE OR REPLACE FUNCTION test_image_policy_failure() RETURNS trigger LANGUAGE plpgsql AS $f$
            BEGIN IF EXISTS (SELECT 1 FROM test_image_policy_fail_owner WHERE id = NEW.media_item_id) THEN RAISE EXCEPTION 'election interrupted'; END IF; RETURN NEW; END $f$`;
        await sql`CREATE TRIGGER test_image_policy_failure BEFORE UPDATE OF selected ON image_candidates FOR EACH ROW EXECUTE FUNCTION test_image_policy_failure()`;
        const order = ['tvdb', ...DEFAULT_IMAGE_CANDIDATE_ORDER.filter((p) => p !== 'tvdb')];
        try {
            await expect(updateImageSelectionPolicy(sql, order, 'provider')).rejects.toThrow(
                'election interrupted',
            );
            const [progress] =
                await sql`SELECT election_pending,election_cursor FROM image_selection_policy`;
            expect(progress.election_pending).toBe(true);
            expect(progress.election_cursor).not.toBe('');
            await sql`DELETE FROM test_image_policy_fail_owner`;
            await updateImageSelectionPolicy(sql, order, 'provider');
            for (const id of owners)
                expect((await getSelectedImageCandidate(sql, id, 'poster'))?.provider).toBe('tvdb');
            const [done] = await sql`SELECT election_pending FROM image_selection_policy`;
            expect(done.election_pending).toBe(false);
        } finally {
            await sql`DROP TRIGGER test_image_policy_failure ON image_candidates`;
            await sql`DROP FUNCTION test_image_policy_failure()`;
            await sql`DROP TABLE test_image_policy_fail_owner`;
        }
    });
});
