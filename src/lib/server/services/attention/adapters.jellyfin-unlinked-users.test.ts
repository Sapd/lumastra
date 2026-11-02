// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { adaptJellyfinUnlinkedUsers, adaptAudiobookshelfUnlinkedUsers } from './adapters.js';
import { ATTENTION_SOURCE_PREFIXES } from './attention-service.js';
import * as m from '$lib/paraglide/messages.js';
import { sectionForItem } from '$lib/shared/attention-section-map.js';
import { IDS_BY_SECTION } from '$lib/shared/__fixtures__/attention-section-ids.js';

describe('Audiobookshelf users without a unique upstream match', () => {
    it('registers an independently reconciled sibling source', () => {
        expect(ATTENTION_SOURCE_PREFIXES).toContain('settings:audiobookshelf-unlinked-users');
        expect(IDS_BY_SECTION.settings).toContain('settings:audiobookshelf-unlinked-users');
    });
    it('names skipped listeners, caps the list, and links to Users', () => {
        expect(adaptAudiobookshelfUnlinkedUsers(0, [])).toEqual([]);
        const [alert] = adaptAudiobookshelfUnlinkedUsers(7, [
            'alice',
            'bob',
            'c',
            'd',
            'e',
            'f',
            'g',
        ]);
        expect(alert.id).toBe('settings:audiobookshelf-unlinked-users');
        expect(alert.severity).toBe('info');
        expect(alert.title).toContain('alice, bob, c, d, e and 2 more');
        expect(alert.detail).toContain('skipped');
        expect(alert.detail).toContain('unique');
        expect(alert.actions[0].href).toBe('/admin/users');
        expect(sectionForItem(alert)).toBe('settings');
    });
});

describe('Jellyfin users with no Lumastra account', () => {
    it('emits nothing when every Jellyfin user has a Lumastra account', () => {
        expect(adaptJellyfinUnlinkedUsers(0, [])).toEqual([]);
    });

    it('names the users and says how to fix it, linked to Users', () => {
        const [alert] = adaptJellyfinUnlinkedUsers(2, ['alice', 'bob']);
        expect(alert.id).toBe('settings:jellyfin-unlinked-users');
        expect(alert.domain).toBe('settings');
        expect(alert.severity).toBe('warning');
        expect(alert.count).toBe(2);
        expect(alert.title).toBe(
            '2 Jellyfin users have no Lumastra account to sync to: alice, bob.',
        );
        expect(alert.detail).toBe(
            'Link them in Users or create matching accounts. Until then their watched state is not synced. This notice reflects the last Jellyfin pull and updates after the next scheduled pull (every 5 minutes by default).',
        );
        expect(alert.sourceRef).toBe('/admin/users');
        expect(alert.actions[0].href).toBe('/admin/users');
        expect(sectionForItem(alert)).toBe('settings');
        expect(ATTENTION_SOURCE_PREFIXES).toContain('settings:jellyfin-unlinked-users');
    });

    it('uses the singular wording for one user', () => {
        const [alert] = adaptJellyfinUnlinkedUsers(1, ['alice']);
        expect(alert.title).toBe('1 Jellyfin user has no Lumastra account to sync to: alice.');
    });

    it('shows at most five names and then "and N more"', () => {
        const [alert] = adaptJellyfinUnlinkedUsers(7, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
        expect(alert.title).toBe(
            '7 Jellyfin users have no Lumastra account to sync to: a1, a2, a3, a4, a5 and 2 more.',
        );
    });
});

it('explains the historical pull and refresh delay in German too', () => {
    expect(m.admin_jellyfin_unlinked_users_detail({}, { locale: 'de' })).toContain(
        'nach dem nächsten geplanten Abruf',
    );
    expect(m.admin_jellyfin_unlinked_users_detail({}, { locale: 'de' })).toContain('5 Minuten');
});
