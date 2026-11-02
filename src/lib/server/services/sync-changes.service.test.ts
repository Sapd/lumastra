// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { decideCatalogChange, isSyncCredential, mergeSyncRows } from './sync-changes.service';
import type { SyncLogRow, SyncItemFacts } from '../database/queries/sync-read.queries';

const row: SyncLogRow = {
    xid: '10',
    seq: '1',
    kind: 'movie',
    entity_id: 'item',
    user_id: null,
    prev_library_ids: [],
    prev_libs_known: false,
    prev_age_rating: null,
    prev_age_known: false,
};
const facts: SyncItemFacts = {
    id: 'item',
    media_type: 'movie',
    in_sync_set: true,
    passes_boundary: true,
    effective_age: 12,
    library_ids: ['allowed'],
    has_any_files: true,
};
const scope = { deniedGroupIds: ['denied'], ageRating: { maxAgeRating: 12, allowUnrated: false } };
const previous = {
    ...row,
    prev_libs_known: true,
    prev_library_ids: ['allowed'],
    prev_age_known: true,
    prev_age_rating: 12,
};

describe('catalog sync decision', () => {
    it('upserts visible current state even when previous state was denied', () => {
        expect(
            decideCatalogChange({ ...previous, prev_library_ids: ['denied'] }, facts, scope),
        ).toBe('upsert');
    });
    it('deletes a moved item only for its previous viewer', () => {
        const moved = { ...facts, passes_boundary: false, library_ids: ['denied'] };
        expect(decideCatalogChange(previous, moved, scope)).toBe('delete');
        expect(
            decideCatalogChange({ ...previous, prev_library_ids: ['denied'] }, moved, scope),
        ).toBeNull();
    });
    it.each(['dismissed', 'inactive', 'unsynced kind', 'last file removed'])(
        'deletes when %s leaves the sync set',
        () => {
            expect(decideCatalogChange(previous, { ...facts, in_sync_set: false }, scope)).toBe(
                'delete',
            );
        },
    );
    it('falls back to current libraries for dismissal and current age for a move', () => {
        expect(decideCatalogChange(row, { ...facts, in_sync_set: false }, scope)).toBe('delete');
        expect(
            decideCatalogChange(
                { ...row, prev_libs_known: true, prev_library_ids: ['allowed'] },
                { ...facts, passes_boundary: false, library_ids: ['denied'] },
                scope,
            ),
        ).toBe('delete');
    });
    it('uses previous series age when the current age exceeds the limit', () => {
        expect(
            decideCatalogChange(
                { ...row, prev_age_known: true, prev_age_rating: 12 },
                { ...facts, effective_age: 18, passes_boundary: false },
                scope,
            ),
        ).toBe('delete');
        expect(
            decideCatalogChange(
                row,
                { ...facts, effective_age: 18, passes_boundary: false },
                scope,
            ),
        ).toBeNull();
    });
    it('deletes missing items only with both known previous axes', () => {
        expect(decideCatalogChange(previous, undefined, scope)).toBe('delete');
        expect(decideCatalogChange(row, undefined, scope)).toBeNull();
        expect(
            decideCatalogChange({ ...previous, prev_age_known: false }, undefined, scope),
        ).toBeNull();
        expect(
            decideCatalogChange({ ...previous, prev_libs_known: false }, undefined, scope),
        ).toBeNull();
    });
    it('never treats a known empty previous library set as visible', () => {
        expect(
            decideCatalogChange({ ...previous, prev_library_ids: [] }, undefined, scope),
        ).toBeNull();
    });
    it('requires files for the unknown-library fallback', () => {
        expect(
            decideCatalogChange(row, { ...facts, in_sync_set: false, has_any_files: false }, scope),
        ).toBeNull();
    });
    it('admin scope permits old restricted libraries and ratings', () => {
        expect(
            decideCatalogChange(
                { ...previous, prev_library_ids: ['denied'], prev_age_rating: 18 },
                undefined,
                { deniedGroupIds: null, ageRating: null },
            ),
        ).toBe('delete');
    });
    it('respects the unrated policy for a known null previous age', () => {
        const unrated = { ...previous, prev_age_rating: null };
        expect(decideCatalogChange(unrated, undefined, scope)).toBeNull();
        expect(
            decideCatalogChange(unrated, undefined, {
                ...scope,
                ageRating: { maxAgeRating: 12, allowUnrated: true },
            }),
        ).toBe('delete');
    });
    it('merges all previous libraries and the earliest known age, retaining newest version', () => {
        const merged = mergeSyncRows([
            { ...previous, xid: '12', seq: '3', prev_library_ids: ['denied'], prev_age_rating: 18 },
            { ...row, xid: '9', prev_library_ids: ['allowed'] },
            { ...previous, xid: '10', prev_age_rating: null },
        ]);
        expect(merged).toMatchObject({
            xid: '12',
            seq: '3',
            prev_libs_known: true,
            prev_age_known: true,
            prev_age_rating: null,
        });
        expect(new Set(merged.prev_library_ids)).toEqual(new Set(['allowed', 'denied']));
        expect(
            decideCatalogChange(merged, undefined, {
                ...scope,
                ageRating: { maxAgeRating: 12, allowUnrated: true },
            }),
        ).toBe('delete');
    });
});

describe('sync credentials', () => {
    it('accepts only the four interactive credential kinds', () => {
        for (const kind of ['session', 'forward_auth', 'pat', 'bearer']) {
            expect(isSyncCredential(kind)).toBe(true);
        }
        for (const kind of [undefined, 'service_token', 'stream_token', 'jellyfin_compat']) {
            expect(isSyncCredential(kind)).toBe(false);
        }
    });
    it('rejects credentials carried in the query string', () => {
        expect(isSyncCredential('pat', new URL('https://x.test/api/v1/sync/changes'))).toBe(true);
        expect(
            isSyncCredential('pat', new URL('https://x.test/api/v1/sync/changes?api_key=abc')),
        ).toBe(false);
        expect(
            isSyncCredential('pat', new URL('https://x.test/api/v1/sync/changes?stream_token=abc')),
        ).toBe(false);
    });
});

describe('nil library (files without a library group)', () => {
    const nil = '00000000-0000-0000-0000-000000000000';
    it('deletes for a restricted caller: such files are visible to everyone', () => {
        const prev = {
            ...row,
            prev_library_ids: [nil],
            prev_libs_known: true,
            prev_age_known: true,
        };
        expect(
            decideCatalogChange(prev, undefined, { deniedGroupIds: ['denied'], ageRating: null }),
        ).toBe('delete');
    });
});
