// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { getPlaylistKindPolicy, isMediaTypeAllowed } from './playlist-kind-policy.js';

describe('playlist kind policy', () => {
    it('treats an unknown or missing type as general', () => {
        expect(getPlaylistKindPolicy(undefined)).toEqual(getPlaylistKindPolicy('general'));
        expect(getPlaylistKindPolicy(null)).toEqual(getPlaylistKindPolicy('general'));
    });

    it('allows everything and expands containers on a general playlist', () => {
        const policy = getPlaylistKindPolicy('general');
        expect(policy.expandContainers).toBe(true);
        expect(policy.sort).toBe('position');
        expect(isMediaTypeAllowed(policy, 'episode')).toBe(true);
        expect(isMediaTypeAllowed(policy, 'track')).toBe(true);
    });

    it('restricts the watchlist to movie, tv and audiobook', () => {
        const policy = getPlaylistKindPolicy('watchlist');
        expect(isMediaTypeAllowed(policy, 'movie')).toBe(true);
        expect(isMediaTypeAllowed(policy, 'tv')).toBe(true);
        expect(isMediaTypeAllowed(policy, 'audiobook')).toBe(true);
        expect(isMediaTypeAllowed(policy, 'episode')).toBe(false);
        expect(isMediaTypeAllowed(policy, 'album')).toBe(false);
        expect(isMediaTypeAllowed(policy, 'track')).toBe(false);
    });

    it('never expands the watchlist and sorts it newest-first', () => {
        const policy = getPlaylistKindPolicy('watchlist');
        expect(policy.expandContainers).toBe(false);
        expect(policy.sort).toBe('added_at_desc');
    });
});
