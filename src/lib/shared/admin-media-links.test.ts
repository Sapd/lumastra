// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    ADMIN_FILE_HEALTH_PATH,
    ADMIN_MEDIA_FILE_ISSUES_PATH,
    buildScanAddedSinceLink,
} from './admin-media-links.js';
import {
    resolveTypes,
    inferDomain,
    defaultTypeForDomain,
} from '../../routes/admin/library/media/media-filters.js';

/**
 * The file-issues deep link must name its own type scope.
 *
 * Without an explicit `type`, the media browser falls back to
 * `defaultTypeForDomain('video')` = 'main' = ['movie','tv'] — so the link built
 * to find files with health problems could not show an affected episode, track
 * or audiobook. Measured on a production catalogue at the time of the fix: the
 * unscoped link listed 28 of 121 affected items.
 */
describe('ADMIN_MEDIA_FILE_ISSUES_PATH', () => {
    const params = new URLSearchParams(ADMIN_MEDIA_FILE_ISSUES_PATH.split('?')[1] ?? '');

    it('points at the media browser', () => {
        expect(ADMIN_MEDIA_FILE_ISSUES_PATH.split('?')[0]).toBe('/admin/library/media');
    });

    it('carries the file-issues filter', () => {
        expect(params.get('filter')).toBe('file-issues');
    });

    it('names an explicit type scope rather than relying on the default', () => {
        expect(params.get('type')).toBeTruthy();
        expect(params.get('domain')).toBeTruthy();
    });

    it('resolves to a type set covering every child media type an issue can land on', () => {
        const types = resolveTypes(params.get('type')!, params.get('domain')!);
        // The types that the unscoped default (['movie','tv']) silently excluded.
        for (const t of ['episode', 'track', 'audiobook', 'season', 'album', 'artist']) {
            expect(types).toContain(t);
        }
        expect(types).toContain('movie');
        expect(types).toContain('tv');
    });

    it('pairs a domain and type that agree, so the link renders the right chips', () => {
        // Same invariant media-filters.ts documents: a type filter that resolves
        // to a type set but infers a different domain renders the wrong chips
        // and the wrong stats tiles.
        expect(inferDomain(params.get('type')!)).toBe(params.get('domain'));
        expect(defaultTypeForDomain(params.get('domain')!)).toBe(params.get('type'));
    });
});

/**
 * The file-health link must NOT be a media-browser link.
 *
 * The attention badge renders `countFilesWithHealthIssues`, a COUNT over
 * `media_files`; the media browser lists `media_items`. Three populations
 * diverge and no value of `?type=` reconciles any of them — see the constant's
 * own docstring. Pinning the surface here is what stops the next person
 * "fixing" a badge/list disagreement by widening a type set again.
 */
describe('ADMIN_FILE_HEALTH_PATH', () => {
    it("points at the System \u2192 Health page's file section", () => {
        expect(ADMIN_FILE_HEALTH_PATH).toBe('/admin/system/health#files');
    });

    it('is not a media-browser link', () => {
        // A list over `media_items` cannot represent a file with no linked item,
        // an `extra` (excluded from ALL_BROWSABLE_TYPES), or the N-items-to-one-file
        // fan-out of a multi-episode file.
        expect(ADMIN_FILE_HEALTH_PATH.startsWith('/admin/library/media')).toBe(false);
        expect(ADMIN_FILE_HEALTH_PATH).not.toContain('filter=file-issues');
    });

    it('is a different surface from the integrity link, which stays row-scoped', () => {
        // Integrity violations ARE scoped to a `media_items` row
        // (`integrity_violations.media_id`), so `adaptIntegrity` correctly keeps
        // the media browser. Only the file-level count moves.
        expect(ADMIN_FILE_HEALTH_PATH).not.toBe(ADMIN_MEDIA_FILE_ISSUES_PATH);
    });
});

/**
 * The scan-run "items changed since" link must pair `domain`/`type` the same
 * way `ADMIN_MEDIA_FILE_ISSUES_PATH` does — this is the enforcement mechanism
 * for that pairing rule, checked against the REAL `inferDomain` /
 * `defaultTypeForDomain`, not against hardcoded literals. A test that only
 * hardcodes `'everything'`/`'all'` would stay green even if
 * `defaultTypeForDomain('everything')` changed out from under this link,
 * silently narrowing it — exactly the defect this file exists to prevent.
 */
describe('buildScanAddedSinceLink', () => {
    const iso = '2026-08-27T10:00:00.000Z';
    const params = new URLSearchParams(buildScanAddedSinceLink(iso).split('?')[1] ?? '');

    it('points at the media browser', () => {
        expect(buildScanAddedSinceLink(iso).split('?')[0]).toBe('/admin/library/media');
    });

    it('carries the added_since timestamp and the created_at/desc sort', () => {
        expect(params.get('added_since')).toBe(iso);
        expect(params.get('sort')).toBe('created_at');
        expect(params.get('order')).toBe('desc');
    });

    it('names an explicit type scope rather than relying on the default', () => {
        expect(params.get('type')).toBeTruthy();
        expect(params.get('domain')).toBeTruthy();
    });

    it('pairs a domain and type that agree, checked against the real media-filters functions', () => {
        expect(inferDomain(params.get('type')!)).toBe(params.get('domain'));
        expect(defaultTypeForDomain(params.get('domain')!)).toBe(params.get('type'));
    });

    it("resolves to a type set covering every domain, matching ADMIN_MEDIA_FILE_ISSUES_PATH's scope", () => {
        const types = resolveTypes(params.get('type')!, params.get('domain')!);
        for (const t of ['episode', 'track', 'audiobook', 'movie', 'tv']) {
            expect(types).toContain(t);
        }
    });
});
