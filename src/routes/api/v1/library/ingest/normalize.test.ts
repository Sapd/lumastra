// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { normalizeDelta } from './normalize.js';
const roots = [{ id: 'm', sourcePrefix: 's3://b/movies/' }];

describe('normalizeDelta', () => {
    it('splits ops and dedups', () => {
        const r = normalizeDelta(
            {
                libraryPathId: 'm',
                changes: [
                    { path: 'a.mkv', op: 'upsert' },
                    { path: 'a.mkv', op: 'upsert' },
                    { path: 'b.mkv', op: 'remove' },
                ],
            },
            roots,
        );
        expect(r).toEqual({ ok: true, libraryPathId: 'm', upsert: ['a.mkv'], remove: ['b.mkv'] });
    });
    it('rejects a path in both upsert and remove', () => {
        const r = normalizeDelta(
            {
                libraryPathId: 'm',
                changes: [
                    { path: 'a.mkv', op: 'upsert' },
                    { path: 'a.mkv', op: 'remove' },
                ],
            },
            roots,
        );
        expect(r.ok).toBe(false);
    });
    it('resolves sourceUri and rejects cross-library', () => {
        expect(
            normalizeDelta(
                { changes: [{ sourceUri: 's3://b/movies/a.mkv', op: 'upsert' }] },
                roots,
            ),
        ).toMatchObject({ ok: true, libraryPathId: 'm', upsert: ['a.mkv'] });
        expect(
            normalizeDelta({ changes: [{ sourceUri: 's3://other/a', op: 'upsert' }] }, roots).ok,
        ).toBe(false);
    });
    it('rejects a path entry containing a traversal sequence', () => {
        const r = normalizeDelta(
            { libraryPathId: 'm', changes: [{ path: '../secret.mkv', op: 'upsert' }] },
            roots,
        );
        expect(r.ok).toBe(false);
    });
    it('rejects cross-library when body libraryPathId conflicts with resolved sourceUri', () => {
        const r = normalizeDelta(
            {
                libraryPathId: 'other-lib',
                changes: [{ sourceUri: 's3://b/movies/a.mkv', op: 'upsert' }],
            },
            roots,
        );
        expect(r.ok).toBe(false);
    });
});
