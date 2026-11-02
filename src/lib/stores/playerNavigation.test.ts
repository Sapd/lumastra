// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/paths', () => ({ base: '/app' }));
import {
    saveReturnPath,
    saveReturnPathFromReferrer,
    getReturnPath,
    updateLastBrowsePage,
} from './playerNavigation';

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    window.history.replaceState({}, '', '/app/browse');
});
it('returns a route without doubling the deployment base and preserves filters and anchor', () => {
    saveReturnPath('/app/browse?q=matrix#results');
    expect(getReturnPath()).toBe('/browse?q=matrix#results');
});
it('keeps the explicit origin when an older document referrer exists', () => {
    saveReturnPath('/app/playlists/saved?filter=movies');
    saveReturnPathFromReferrer(new URL('/app/browse', window.location.origin).href);
    expect(getReturnPath()).toBe('/playlists/saved?filter=movies');
});
it('captures a same-origin browse referrer for a full-page arrival', () => {
    saveReturnPathFromReferrer(new URL('/app/browse?q=matrix', window.location.origin).href);
    expect(getReturnPath()).toBe('/browse?q=matrix');
});
it('rejects external referrers and stale player destinations', () => {
    saveReturnPathFromReferrer('https://other.test/app/browse');
    sessionStorage.setItem('player:returnPath', '/app/watch/movie');
    expect(getReturnPath('TvChannel')).toBe('/livetv');
});
it('preserves the original destination while switching episodes', () => {
    saveReturnPath('/app/browse');
    saveReturnPath('/app/watch/episode-2');
    expect(getReturnPath()).toBe('/browse');
});
it('normalizes persisted browse fallback and ignores paths outside this deployment', () => {
    updateLastBrowsePage('/app/browse?type=movies');
    expect(getReturnPath()).toBe('/browse?type=movies');
    localStorage.setItem('player:lastBrowsePage', '/elsewhere');
    expect(getReturnPath()).toBe('/');
});

it('remembers the subfolder home page with its trailing slash', () => {
    updateLastBrowsePage('/app/?section=watchlist');
    expect(getReturnPath()).toBe('/?section=watchlist');
});
