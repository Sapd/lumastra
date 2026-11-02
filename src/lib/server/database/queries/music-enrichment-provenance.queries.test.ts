// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
const mocks = vi.hoisted(() => ({ lock: vi.fn(), setter: vi.fn() }));
vi.mock('./media-artwork.queries.js', () => ({ lockArtworkOwners: mocks.lock }));
vi.mock('./album-enrichment.queries.js', () => ({ setAlbumCoverArtUrlIfNull: mocks.setter }));
import { persistAlbumCoverArtFallback } from './music-enrichment-provenance.queries.js';
beforeEach(() => {
    vi.clearAllMocks();
});
it('rolls back a fallback URL when its provenance write fails in the same transaction', async () => {
    let poster: string | null = null;
    const tx = Object.assign(
        vi.fn(async (strings: TemplateStringsArray) => {
            if (strings.join('').includes('SELECT')) return [{ poster: true, backdrop: true }];
            throw new Error('provenance persistence failed');
        }),
        { json: (value: unknown) => value },
    );
    mocks.setter.mockImplementation(async (_sql, _id, value: string) => {
        poster = value;
        return true;
    });
    const sql = {
        begin: async (callback: (tx: unknown) => Promise<unknown>) => {
            const previous = poster;
            try {
                return await callback(tx);
            } catch (error) {
                poster = previous;
                throw error;
            }
        },
    } as unknown as postgres.Sql;
    await expect(persistAlbumCoverArtFallback(sql, 'album', 'caa')).rejects.toThrow(
        'provenance persistence failed',
    );
    expect(poster).toBeNull();
    expect(mocks.lock).toHaveBeenCalledWith(tx, ['album']);
    expect(mocks.setter).toHaveBeenCalledWith(tx, 'album', 'caa');
});
it('rechecks ownership after acquiring the lock and leaves concurrent curated art intact', async () => {
    let writable = true;
    const tx = Object.assign(
        vi.fn(async () => [{ poster: writable, backdrop: true }]),
        { json: (value: unknown) => value },
    );
    mocks.lock.mockImplementation(async () => {
        writable = false;
    });
    const sql = {
        begin: (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
    } as unknown as postgres.Sql;
    expect(await persistAlbumCoverArtFallback(sql, 'album', 'caa')).toBe(false);
    expect(mocks.setter).not.toHaveBeenCalled();
});
