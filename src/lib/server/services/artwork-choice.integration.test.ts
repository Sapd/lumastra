// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { mutateImageCandidates } from './image-candidates.service.js';
import { withArtworkChoice } from './artwork-choice.service.js';
import { captureArtworkChoice } from '$lib/server/database/queries/artwork-choice.queries.js';
import {
    registerImageCandidate,
    listImageCandidates,
    getSuppressedImageProviders,
} from '$lib/server/database/queries/image-candidates.queries.js';
import {
    upsertLocalArtwork,
    getOwnLocalArtwork,
} from '$lib/server/database/queries/media-artwork.queries.js';
import { resolveImageSet } from './image-descriptor/resolver.js';

vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => ({ invalidateCatalogImage: vi.fn() }),
}));

describe('recoverable artwork choices (real database)', () => {
    const ids: string[] = [];
    let dir: string;
    const sql = getTestDb();
    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'artwork-choice-'));
    });
    afterEach(async () => {
        await sql`DELETE FROM audit_log WHERE target=ANY(${ids}::text[])`;
        await sql`DELETE FROM media_items WHERE id=ANY(${ids}::uuid[])`;
        ids.length = 0;
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
        await closeTestDb();
    });
    async function owner(): Promise<string> {
        const id = randomUUID();
        ids.push(id);
        await sql`INSERT INTO media_items (id,title,media_type) VALUES (${id},'The Amber Observatory','movie')`;
        return id;
    }
    it('restores the complete ordered selection, locks and source suppression while retaining metadata', async () => {
        const id = await owner();
        for (const role of ['poster', 'backdrop', 'logo'] as const) {
            await registerImageCandidate(sql, {
                mediaItemId: id,
                role,
                provider: 'tmdb',
                providerRef: `/${role}-one.jpg`,
            });
            await registerImageCandidate(sql, {
                mediaItemId: id,
                role,
                provider: 'tmdb',
                providerRef: `/${role}-two.jpg`,
            });
        }
        const candidates = await listImageCandidates(sql, id);
        await mutateImageCandidates(
            sql,
            id,
            {
                action: 'select',
                candidateId: candidates.find((c) => c.artwork_type === 'backdrop')!.id,
                locked: true,
            },
            'admin',
        );
        await sql`INSERT INTO image_provider_suppressions VALUES (${id},'tvdb','logo')`;
        await sql`INSERT INTO provider_metadata (media_id,provider,metadata) VALUES (${id},'tmdb','{"poster_path":"/poster-one.jpg"}')`;
        const before = await captureArtworkChoice(sql, id);
        const result = await mutateImageCandidates(
            sql,
            id,
            { action: 'suppress-provider', provider: 'tmdb' },
            'admin',
        );
        expect((await listImageCandidates(sql, id)).every((c) => c.suppressed && !c.selected)).toBe(
            true,
        );
        expect(
            await registerImageCandidate(sql, {
                mediaItemId: id,
                role: 'poster',
                provider: 'tmdb',
                providerRef: '/future.jpg',
            }),
        ).toBeNull();
        const [receipt] =
            await sql`SELECT after_state FROM admin_media_change_receipts WHERE id=${result.undoId!}`;
        expect(receipt.after_state).toEqual(await captureArtworkChoice(sql, id));
        await mutateImageCandidates(
            sql,
            id,
            { action: 'undo', receiptId: result.undoId! },
            'admin',
        );
        expect(await captureArtworkChoice(sql, id)).toEqual(before);
        expect(
            (await sql`SELECT metadata FROM provider_metadata WHERE media_id=${id}`)[0].metadata,
        ).toEqual({ poster_path: '/poster-one.jpg' });
        await mutateImageCandidates(
            sql,
            id,
            { action: 'undo', receiptId: result.undoId! },
            'admin',
        );
        expect(await captureArtworkChoice(sql, id)).toEqual(before);
    });
    it('restores an unavailable remote reference as a choice without pretending to download it', async () => {
        const id = await owner();
        const candidate = await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'poster',
            provider: 'tmdb',
            providerRef: '/unavailable-remote.jpg',
        });
        const before = await captureArtworkChoice(sql, id);
        const selected = await mutateImageCandidates(
            sql,
            id,
            { action: 'select', candidateId: candidate!, locked: true },
            'admin',
        );
        const automatic = await mutateImageCandidates(
            sql,
            id,
            { action: 'automatic', role: 'poster' },
            'admin',
        );
        await mutateImageCandidates(
            sql,
            id,
            { action: 'undo', receiptId: automatic.undoId! },
            'admin',
        );
        expect((await listImageCandidates(sql, id))[0]).toMatchObject({
            selected: true,
            locked: true,
            chosen_by: 'admin',
        });
        await mutateImageCandidates(
            sql,
            id,
            { action: 'undo', receiptId: selected.undoId! },
            'admin',
        );
        expect(await captureArtworkChoice(sql, id)).toEqual(before);
    });
    it('keeps old and newly uploaded bytes, refuses a missing old file and rejects stale Undo', async () => {
        const id = await owner();
        const old = join(dir, randomUUID() + '.jpg');
        const next = join(dir, randomUUID() + '.jpg');
        await writeFile(old, 'original-picture');
        await writeFile(next, 'new-picture');
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'poster',
            filePath: old,
            sourceTag: 'admin:file',
            localContentHash: createHash('sha256').update('original-picture').digest('hex'),
        });
        const before = await captureArtworkChoice(sql, id);
        const result = await withArtworkChoice(sql, id, 'admin', (tx) =>
            upsertLocalArtwork(tx, {
                mediaItemId: id,
                artworkType: 'poster',
                filePath: next,
                sourceTag: 'admin:file',
            }),
        );
        await rm(old);
        await expect(
            mutateImageCandidates(sql, id, { action: 'undo', receiptId: result.undoId! }, 'admin'),
        ).rejects.toThrow('unavailable');
        await writeFile(old, 'changed-picture');
        await expect(
            mutateImageCandidates(sql, id, { action: 'undo', receiptId: result.undoId! }, 'admin'),
        ).rejects.toThrow('file changed');
        await writeFile(old, 'original-picture');
        await mutateImageCandidates(
            sql,
            id,
            { action: 'undo', receiptId: result.undoId! },
            'admin',
        );
        const retained = await listImageCandidates(sql, id);
        expect(retained.find((c) => c.file_path === old)).toMatchObject({
            selected: true,
            locked: true,
        });
        expect(retained.find((c) => c.file_path === next)).toMatchObject({
            selected: false,
            suppressed: true,
        });
        await sql`SELECT reselect_image_candidates(${id}::uuid)`;
        expect((await listImageCandidates(sql, id)).find((c) => c.file_path === old)).toMatchObject(
            { selected: true },
        );
        expect(await readFile(old, 'utf8')).toBe('original-picture');
        expect(await readFile(next, 'utf8')).toBe('new-picture');
        expect(before).toBeTruthy();
        const choice = await mutateImageCandidates(
            sql,
            id,
            { action: 'automatic', role: 'poster' },
            'admin',
        );
        await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'logo',
            provider: 'tvdb',
            providerRef: '/changed.jpg',
        });
        await expect(
            mutateImageCandidates(sql, id, { action: 'undo', receiptId: choice.undoId! }, 'admin'),
        ).rejects.toThrow('changed since');
    });
    it('allows an explicit archived picture choice without un-hiding other source roles', async () => {
        const id = await owner();
        const poster = await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'poster',
            provider: 'tmdb',
            providerRef: '/choice.jpg',
        });
        await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'logo',
            provider: 'tmdb',
            providerRef: '/logo.jpg',
        });
        await mutateImageCandidates(
            sql,
            id,
            { action: 'suppress-provider', provider: 'tmdb' },
            'admin',
        );
        await mutateImageCandidates(
            sql,
            id,
            { action: 'select', candidateId: poster!, locked: true },
            'admin',
        );
        const candidates = await listImageCandidates(sql, id);
        expect(candidates.find((c) => c.id === poster)).toMatchObject({
            selected: true,
            suppressed: false,
            locked: true,
        });
        expect(candidates.find((c) => c.artwork_type === 'logo')).toMatchObject({
            selected: false,
            suppressed: true,
        });
        expect(
            (await sql`SELECT role FROM image_provider_suppressions WHERE owner=${id}`).map(
                (row) => row.role,
            ),
        ).not.toContain('poster');
    });
    it.each([false, true])(
        'restores the previous bytes or remote reference when the same URL reuses one candidate (remote before: %s)',
        async (remoteBefore) => {
            const id = await owner();
            const url = 'https://artwork.example.test/amber-observatory.jpg';
            const old = join(dir, randomUUID() + '.jpg');
            const next = join(dir, randomUUID() + '.jpg');
            await writeFile(old, 'older URL bytes');
            await writeFile(next, 'newer URL bytes');
            if (remoteBefore)
                await registerImageCandidate(sql, {
                    mediaItemId: id,
                    role: 'poster',
                    provider: 'tmdb',
                    providerRef: url,
                    remoteUrl: url,
                });
            else
                await upsertLocalArtwork(sql, {
                    mediaItemId: id,
                    artworkType: 'poster',
                    filePath: old,
                    sourceTag: 'admin:url',
                    provider: 'tmdb',
                    providerRef: url,
                });
            const before = await captureArtworkChoice(sql, id);
            const original = (await listImageCandidates(sql, id))[0];
            const changed = await withArtworkChoice(sql, id, 'admin', (tx) =>
                upsertLocalArtwork(tx, {
                    mediaItemId: id,
                    artworkType: 'poster',
                    filePath: next,
                    sourceTag: 'admin:url',
                    provider: 'tmdb',
                    providerRef: url,
                }),
            );
            expect((await listImageCandidates(sql, id))[0]).toMatchObject({
                id: original.id,
                file_path: next,
            });
            await mutateImageCandidates(
                sql,
                id,
                { action: 'undo', receiptId: changed.undoId! },
                'admin',
            );
            expect(await captureArtworkChoice(sql, id)).toEqual(before);
            expect((await listImageCandidates(sql, id))[0]).toMatchObject({
                id: original.id,
                file_path: remoteBefore ? null : old,
            });
            expect((await getOwnLocalArtwork(sql, id, 'poster'))?.file_path ?? null).toBe(
                remoteBefore ? null : old,
            );
            expect(await readFile(old, 'utf8')).toBe('older URL bytes');
            expect(await readFile(next, 'utf8')).toBe('newer URL bytes');
        },
    );
    it('hides only the chosen image, falls back, and automatic lifts legacy slot suppression', async () => {
        const id = await owner();
        const fallback = await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'poster',
            provider: 'tmdb',
            providerRef: '/fallback.jpg',
        });
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'poster',
            filePath: '/library/chosen.jpg',
            sourceTag: 'admin:file',
        });
        const custom = (await listImageCandidates(sql, id)).find(
            (candidate) => candidate.file_path === '/library/chosen.jpg',
        )!.id;
        await mutateImageCandidates(
            sql,
            id,
            { action: 'select', candidateId: custom!, locked: true },
            'admin',
        );
        await mutateImageCandidates(sql, id, { action: 'hide', candidateId: custom! }, 'admin');
        expect((await listImageCandidates(sql, id)).find((c) => c.id === fallback)).toMatchObject({
            selected: true,
            suppressed: false,
        });
        expect((await listImageCandidates(sql, id)).find((c) => c.id === custom)).toMatchObject({
            selected: false,
            suppressed: true,
        });
        expect(await resolveImageSet(sql, 'v1', id)).toHaveProperty('poster');
        // Capture can lag on older owners: a hidden upload must still allow a
        // different legacy TMDB pointer while its candidate is not registered.
        await sql`INSERT INTO provider_metadata(media_id,provider,metadata) VALUES (${id},'tmdb','{"poster_path":"/fallback.jpg"}')`;
        await sql`DELETE FROM image_candidates WHERE id=${fallback!}`;
        expect(await resolveImageSet(sql, 'v1', id)).toHaveProperty('poster');
        expect(await getSuppressedImageProviders(sql, id, 'poster')).not.toContain('tmdb');
        await sql`INSERT INTO image_provider_suppressions (owner,provider,role) VALUES (${id},'*','poster') ON CONFLICT DO NOTHING`;
        await mutateImageCandidates(sql, id, { action: 'automatic', role: 'poster' }, 'admin');
        expect((await listImageCandidates(sql, id)).every((c) => !c.suppressed)).toBe(true);
        expect(
            await sql`SELECT 1 FROM image_provider_suppressions WHERE owner=${id} AND provider='*' AND role='poster'`,
        ).toHaveLength(0);
        expect(
            await registerImageCandidate(sql, {
                mediaItemId: id,
                role: 'poster',
                provider: 'tmdb',
                providerRef: '/regenerated.jpg',
            }),
        ).not.toBeNull();
    });
    it('automatic lifts a legacy thumbnail slot removal so pictures can be selected again', async () => {
        const id = await owner();
        await sql`UPDATE media_items SET media_type='episode' WHERE id=${id}`;
        await sql`INSERT INTO image_provider_suppressions(owner,provider,role) VALUES (${id},'*','thumb')`;
        const candidate = await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'thumb',
            provider: 'tmdb',
            providerRef: '/frame.jpg',
        });
        expect(
            (await listImageCandidates(sql, id)).find((image) => image.id === candidate)?.selected,
        ).toBe(false);
        await mutateImageCandidates(sql, id, { action: 'automatic', role: 'thumb' }, 'admin');
        expect(
            (await listImageCandidates(sql, id)).find((image) => image.id === candidate),
        ).toMatchObject({ selected: true, suppressed: false });
    });
    it('does not create recovery receipts for rejected artwork writes', async () => {
        const id = await owner();
        expect((await withArtworkChoice(sql, id, 'admin', async () => false)).value).toBe(false);
        expect(await sql`SELECT 1 FROM admin_media_change_receipts WHERE owner=${id}`).toHaveLength(
            0,
        );
    });
    it('hiding one picture leaves its provider available for other legacy images; explicit bans still apply', async () => {
        const id = await owner();
        const hidden = await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'poster',
            provider: 'tmdb',
            providerRef: '/hidden.jpg',
        });
        await mutateImageCandidates(sql, id, { action: 'hide', candidateId: hidden! }, 'admin');
        await sql`INSERT INTO provider_metadata(media_id,provider,metadata) VALUES (${id},'tmdb','{"poster_path":"/different.jpg"}')`;
        // Exercise legacy fallback without an elected/registered replacement.
        await sql`DELETE FROM image_candidates WHERE media_item_id=${id} AND NOT suppressed`;
        expect(await getSuppressedImageProviders(sql, id, 'poster')).not.toContain('tmdb');
        expect(await resolveImageSet(sql, 'v1', id)).toHaveProperty('poster');
        await sql`INSERT INTO image_provider_suppressions(owner,provider,role) VALUES (${id},'tmdb','*')`;
        expect(await getSuppressedImageProviders(sql, id, 'poster')).toContain('tmdb');
        expect(await getSuppressedImageProviders(sql, id, 'thumb')).toContain('tmdb');
        await sql`DELETE FROM image_provider_suppressions WHERE owner=${id}`;
        await sql`INSERT INTO image_provider_suppressions(owner,provider,role) VALUES (${id},'*','poster')`;
        expect(await getSuppressedImageProviders(sql, id, 'poster')).toContain('tmdb');
        expect(await getSuppressedImageProviders(sql, id, 'thumb')).toEqual([]);
    });
    it('hides the only candidate and Undo restores the same image', async () => {
        const id = await owner();
        await sql`INSERT INTO provider_metadata(media_id,provider,metadata) VALUES (${id},'tmdb','{"poster_path":"/old.jpg"}')`;
        const candidate = await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'poster',
            provider: 'tmdb',
            providerRef: '/old.jpg',
        });
        const hidden = await mutateImageCandidates(
            sql,
            id,
            { action: 'hide', candidateId: candidate! },
            'admin',
        );
        expect((await listImageCandidates(sql, id)).some((c) => c.selected)).toBe(false);
        expect(await resolveImageSet(sql, 'v1', id)).toEqual({});
        expect(await getSuppressedImageProviders(sql, id, 'poster')).not.toContain('tmdb');
        await mutateImageCandidates(
            sql,
            id,
            { action: 'undo', receiptId: hidden.undoId! },
            'admin',
        );
        expect((await listImageCandidates(sql, id))[0]).toMatchObject({
            id: candidate,
            selected: true,
            suppressed: false,
        });
    });
});
