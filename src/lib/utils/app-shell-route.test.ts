// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * app-shell-route — the route classification +layout.svelte's template
 * {#if isAuthPage}...{:else if isShowcasePage}...{:else} branches on, and
 * that Task 8's music-store bootstrap gate (fix round 1, Critical 1) is
 * driven by via isAppShellRoute(). See that file's own doc comment for why
 * this was extracted: the hand-composed `!isAuthPage && !isShowcasePage` in
 * the $effect was exercised by no test, so a dropped `!` or a swapped
 * `&&`/`||` would have silently reintroduced Critical 1 (audio resuming on
 * /login) with everything else green.
 */

import { describe, expect, it } from 'vitest';
import { isAppShellRoute, isAuthRoute, isShowcaseRoute } from './app-shell-route';

describe('isAuthRoute', () => {
    it('matches /login and /setup exactly, at the root (no base)', () => {
        expect(isAuthRoute('/login', '')).toBe(true);
        expect(isAuthRoute('/setup', '')).toBe(true);
    });

    it('matches the standalone "setup is locked" page', () => {
        expect(isAuthRoute('/setup/locked', '')).toBe(true);
        expect(isAuthRoute('/app/setup/locked', '/app')).toBe(true);
        expect(isAuthRoute('/setup/lockedx', '')).toBe(false);
    });

    it('does not match a nested or prefixed path — exact match only', () => {
        expect(isAuthRoute('/login/', '')).toBe(false);
        expect(isAuthRoute('/login/foo', '')).toBe(false);
        expect(isAuthRoute('/loginx', '')).toBe(false);
        expect(isAuthRoute('/settings/login', '')).toBe(false);
    });

    it('respects a subfolder-deployment base path', () => {
        expect(isAuthRoute('/app/login', '/app')).toBe(true);
        expect(isAuthRoute('/app/setup', '/app')).toBe(true);
        // The unprefixed path is NOT a match once a base is configured.
        expect(isAuthRoute('/login', '/app')).toBe(false);
    });

    it('does not match ordinary app routes', () => {
        expect(isAuthRoute('/', '')).toBe(false);
        expect(isAuthRoute('/browse', '')).toBe(false);
        expect(isAuthRoute('/music', '')).toBe(false);
    });
});

describe('isShowcaseRoute', () => {
    it('matches /showcase and any nested path under it, at the root', () => {
        expect(isShowcaseRoute('/showcase', '')).toBe(true);
        expect(isShowcaseRoute('/showcase/x', '')).toBe(true);
        expect(isShowcaseRoute('/showcase/deep/nested', '')).toBe(true);
    });

    it('respects a subfolder-deployment base path', () => {
        expect(isShowcaseRoute('/app/showcase', '/app')).toBe(true);
        expect(isShowcaseRoute('/app/showcase/x', '/app')).toBe(true);
        expect(isShowcaseRoute('/showcase', '/app')).toBe(false);
    });

    it('does not match ordinary app routes', () => {
        expect(isShowcaseRoute('/', '')).toBe(false);
        expect(isShowcaseRoute('/browse', '')).toBe(false);
        expect(isShowcaseRoute('/music', '')).toBe(false);
    });
});

describe('isAppShellRoute — gates Task 8 Critical 1 (music-store bootstrap)', () => {
    it.each([
        ['/login', ''],
        ['/setup', ''],
        ['/showcase', ''],
        ['/showcase/x', ''],
    ])('%s (base %j) is NOT an app-shell route', (pathname, base) => {
        expect(isAppShellRoute(pathname, base)).toBe(false);
    });

    it.each([
        ['/', ''],
        ['/browse', ''],
        ['/music', ''],
    ])('%s (base %j) IS an app-shell route', (pathname, base) => {
        expect(isAppShellRoute(pathname, base)).toBe(true);
    });

    it('honours the base path for both the exclusions and the app-shell routes', () => {
        expect(isAppShellRoute('/app/login', '/app')).toBe(false);
        expect(isAppShellRoute('/app/showcase/x', '/app')).toBe(false);
        expect(isAppShellRoute('/app/browse', '/app')).toBe(true);
        expect(isAppShellRoute('/app/music', '/app')).toBe(true);
        expect(isAppShellRoute('/app', '/app')).toBe(true);
    });
});
