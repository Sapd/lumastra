// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

const checkAccessMock = vi.fn();
const summaryMock = vi.fn();
const navMock = vi.fn();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => checkAccessMock(...a),
}));
vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    getMediaItemSummaryById: (...a: unknown[]) => summaryMock(...a),
    getMediaNavContext: (...a: unknown[]) => navMock(...a),
}));

import { buildMediaResolution } from './context-primitives.js';

const sql = {} as never;
// A real UserContext must be supplied as `raw` — checkMediaAccess reads it and
// resolveOne fails closed without it (see the security note in resolveOne).
const rawUser = {
    username: 'alice',
    userGroups: [],
    isAdmin: false,
    maxAgeRating: null,
    isAgeRestricted: false,
};
const user = {
    username: 'alice',
    groups: [],
    isAdmin: false,
    hasLiveTvPermission: false,
    raw: rawUser,
};

beforeEach(() => {
    checkAccessMock.mockReset();
    summaryMock.mockReset();
    navMock.mockReset();
});

describe('buildMediaResolution.resolveForViewer', () => {
    it('returns an allowed chip with title + openHref for a permitted movie', async () => {
        summaryMock.mockResolvedValue({ id: 'u1', title: 'Haze', year: 1995, media_type: 'movie' });
        checkAccessMock.mockResolvedValue(true);
        const media = buildMediaResolution(sql, user as never);
        const [chip] = await media.resolveForViewer([{ id: 'u1', mediaType: 'movie' }]);
        expect(chip.allowed).toBe(true);
        expect(chip.title).toBe('Haze');
        expect(chip.openHref).toBe('?modal=u1');
    });

    it('returns inert chip (no title/href) when access denied', async () => {
        summaryMock.mockResolvedValue({
            id: 'u2',
            title: 'Adult',
            year: 2020,
            media_type: 'movie',
        });
        checkAccessMock.mockResolvedValue(false);
        const media = buildMediaResolution(sql, user as never);
        const [chip] = await media.resolveForViewer([{ id: 'u2', mediaType: 'movie' }]);
        expect(chip.allowed).toBe(false);
        expect(chip.title).toBeUndefined();
        expect(chip.openHref).toBeUndefined();
    });

    it('returns inert chip for a missing item', async () => {
        summaryMock.mockResolvedValue(null);
        const media = buildMediaResolution(sql, user as never);
        const [chip] = await media.resolveForViewer([{ id: 'gone', mediaType: 'movie' }]);
        expect(chip.allowed).toBe(false);
    });

    it('denies a tvchannel when the viewer lacks live-TV permission even if checkMediaAccess passes', async () => {
        summaryMock.mockResolvedValue({
            id: 'c1',
            title: 'WBN',
            year: null,
            media_type: 'tvchannel',
        });
        checkAccessMock.mockResolvedValue(true);
        const media = buildMediaResolution(sql, { ...user, hasLiveTvPermission: false } as never);
        const [chip] = await media.resolveForViewer([{ id: 'c1', mediaType: 'tvchannel' }]);
        expect(chip.allowed).toBe(false);
    });

    it('opens the parent-series modal with season + episode preselected for an episode chip', async () => {
        summaryMock.mockResolvedValue({
            id: 'ep1',
            title: 'Orionlands',
            year: 2013,
            media_type: 'episode',
        });
        checkAccessMock.mockResolvedValue(true);
        navMock.mockResolvedValue({
            media_type: 'episode',
            series_id: 'series-uuid',
            season_number: 5,
            episode_number: 14,
        });
        const media = buildMediaResolution(sql, user as never);
        const [chip] = await media.resolveForViewer([{ id: 'ep1', mediaType: 'episode' }]);
        expect(chip.allowed).toBe(true);
        expect(chip.openHref).toBe('?modal=series-uuid&season=5&episode=14');
    });

    it('opens the parent-series modal with season preselected for a season chip', async () => {
        summaryMock.mockResolvedValue({
            id: 's1',
            title: 'Season 5',
            year: 2013,
            media_type: 'season',
        });
        checkAccessMock.mockResolvedValue(true);
        navMock.mockResolvedValue({
            media_type: 'season',
            series_id: 'series-uuid',
            season_number: 5,
            episode_number: null,
        });
        const media = buildMediaResolution(sql, user as never);
        const [chip] = await media.resolveForViewer([{ id: 's1', mediaType: 'season' }]);
        expect(chip.allowed).toBe(true);
        expect(chip.openHref).toBe('?modal=series-uuid&season=5');
    });

    it('fails closed (denies) when no host UserContext (raw) is supplied — does not bypass the gates', async () => {
        summaryMock.mockResolvedValue({ id: 'u1', title: 'Haze', year: 1995, media_type: 'movie' });
        checkAccessMock.mockResolvedValue(true);
        // Viewer without `raw` — must NOT silently resolve to an empty-group user.
        const viewerNoRaw = {
            username: 'alice',
            groups: [],
            isAdmin: false,
            hasLiveTvPermission: false,
        };
        const media = buildMediaResolution(sql, viewerNoRaw as never);
        const [chip] = await media.resolveForViewer([{ id: 'u1', mediaType: 'movie' }]);
        expect(chip.allowed).toBe(false);
        // The access check must not even be consulted against the wrong shape.
        expect(checkAccessMock).not.toHaveBeenCalled();
    });
});
