// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { searchSettings } from './settings-search-index';

const allEnabled = new Set([
    'account',
    'sessions',
    'connections',
    'display',
    'privacy',
    'playback',
    'subtitles',
    'home',
    'about',
]);

describe('searchSettings', () => {
    test('empty query returns no hits', () => {
        expect(searchSettings('', allEnabled)).toEqual([]);
        expect(searchSettings('   ', allEnabled)).toEqual([]);
    });

    test('finds the visible playback countdown, popup and seek controls', () => {
        expect(searchSettings('countdown', allEnabled)).toContainEqual({
            sectionId: 'playback',
            label: 'Countdown before the next episode starts',
            query: 'highlight=autoplay',
        });
        expect(
            searchSettings('popup', allEnabled).some(
                (hit) => hit.query === 'highlight=show-next-popup',
            ),
        ).toBe(true);
        expect(
            searchSettings('zurückspulen', allEnabled).some((hit) => hit.sectionId === 'playback'),
        ).toBe(true);
    });

    test('synonym "captions" maps to the Subtitles section', () => {
        const hits = searchSettings('captions', allEnabled);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((h) => h.sectionId === 'subtitles')).toBe(true);
    });

    test('"sign out" maps to the Sessions section', () => {
        const hits = searchSettings('sign out', allEnabled);
        expect(hits.some((h) => h.sectionId === 'sessions')).toBe(true);
    });

    test('hits from disabled sections are excluded', () => {
        const noSessions = new Set([...allEnabled].filter((id) => id !== 'sessions'));
        const hits = searchSettings('sign out', noSessions);
        expect(hits.some((h) => h.sectionId === 'sessions')).toBe(false);
    });

    test('matches against the visible control label too', () => {
        const hits = searchSettings('api token', allEnabled);
        expect(hits.some((h) => h.sectionId === 'account')).toBe(true);
    });

    test('does not false-match a keyword that is merely a substring of the query', () => {
        // "account" contains "cc" (a subtitles keyword) — must NOT surface subtitles.
        const account = searchSettings('account', allEnabled);
        expect(account.some((h) => h.sectionId === 'subtitles')).toBe(false);
        // "database" contains "data" (a playback keyword) — must NOT surface playback.
        const database = searchSettings('database', allEnabled);
        expect(database.some((h) => h.sectionId === 'playback')).toBe(false);
    });

    test('"jellyfin" surfaces a dedicated connect-modal deep link', () => {
        const hits = searchSettings('jellyfin', allEnabled);
        const hit = hits.find((h) => h.query === 'connect=jellyfin');
        expect(hit).toBeTruthy();
        expect(hit?.sectionId).toBe('connections');
        expect(hit?.label).toBe('Set up a Jellyfin app');
    });

    test('"subsonic" surfaces a dedicated connect-modal deep link', () => {
        const hits = searchSettings('subsonic', allEnabled);
        const hit = hits.find((h) => h.query === 'connect=subsonic');
        expect(hit).toBeTruthy();
        expect(hit?.sectionId).toBe('connections');
        expect(hit?.label).toBe('Set up a music app');
    });

    test('the generic Connections entry has no query (links to the bare section)', () => {
        const hits = searchSettings('sync', allEnabled);
        const generic = hits.find((h) => h.sectionId === 'connections' && !h.query);
        expect(generic).toBeTruthy();
        expect(generic?.query).toBeUndefined();
    });

    // Found in a review of a production install: "Hide my streams" linked to Display (the
    // switch is on Privacy) and "Password" linked to an Account page with no
    // password on it for SSO users.
    test('"hide" links to Privacy, where the switch lives', () => {
        const hits = searchSettings('hide my', allEnabled);
        expect(hits.map((h) => h.sectionId)).toEqual(['privacy']);
    });

    test('the account password is only offered to built-in logins', () => {
        const sso = searchSettings('password', allEnabled, { authMethod: 'forward_auth' });
        expect(sso.some((h) => h.sectionId === 'account')).toBe(false);
        expect(
            sso.some((h) => h.sectionId === 'connections' && h.query === 'connect=jellyfin'),
        ).toBe(true);
        const native = searchSettings('password', allEnabled, { authMethod: 'session' });
        expect(native.some((h) => h.sectionId === 'account')).toBe(true);
    });

    test.each([
        ['theme', 'display'],
        ['notifications', 'display'],
        ['trakt', 'connections'],
        ['forced', 'subtitles'],
        ['quick connect', 'connections'],
        ['speed', 'playback'],
    ])('"%s" finds something in %s', (query, section) => {
        expect(searchSettings(query, allEnabled).some((h) => h.sectionId === section)).toBe(true);
    });
});
