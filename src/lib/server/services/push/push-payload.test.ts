// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { Logger } from '$lib/server/utils/logger.js';

// White-labelling is a licensed product feature (`branding_removal`), and a
// push banner is one of the few surfaces where the product name appears with
// none of its own chrome around it — so the title must follow the configured
// brand, not a literal.
const branding = { appName: 'Lumastra' };
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: {
            ...actual.config,
            get APP_NAME() {
                return branding.appName;
            },
        },
    };
});

import {
    buildPushPayload,
    resolvePushLocale,
    pushExpirationEpochSeconds,
    PUSH_PAYLOAD_VERSION,
} from './push-payload.js';

const NID = '11111111-1111-4111-8111-111111111111';

describe('resolvePushLocale', () => {
    it('maps a German tag to de', () => {
        expect(resolvePushLocale('de-DE')).toBe('de');
        expect(resolvePushLocale('de')).toBe('de');
    });

    it('falls back to en for null and for an unsupported tag', () => {
        expect(resolvePushLocale(null)).toBe('en');
        expect(resolvePushLocale('fr-FR')).toBe('en');
        expect(resolvePushLocale('')).toBe('en');
    });

    it('does not match a tag that merely starts with "de" but is not the de subtag', () => {
        expect(resolvePushLocale('deu')).toBe('en');
    });
});

describe('buildPushPayload — branded title', () => {
    it('titles the banner with the configured brand, not the literal "Lumastra"', () => {
        branding.appName = 'Acme Media';
        const p = buildPushPayload({
            kind: 'library.new_episode',
            notificationId: NID,
            badge: 1,
            locale: 'en-US',
            mode: 'content-free',
        });
        expect(p.aps.alert.title).toBe('Acme Media');
        // Only the title is branded; the body is still a localized string.
        expect(p.aps.alert.body).toBe('New episode available');
        branding.appName = 'Lumastra';
    });

    it('falls back to the Paraglide title when APP_NAME is blank', () => {
        // An empty alert.title renders as a gap on the lock screen.
        branding.appName = '   ';
        const p = buildPushPayload({
            kind: 'library.new_episode',
            notificationId: NID,
            badge: 1,
            locale: 'de-DE',
            mode: 'content-free',
        });
        expect(p.aps.alert.title).toBe('Lumastra');
        branding.appName = 'Lumastra';
    });
});

describe('buildPushPayload — content-free', () => {
    it('renders the generic title and a per-kind body in English', () => {
        const p = buildPushPayload({
            kind: 'library.new_episode',
            notificationId: NID,
            badge: 3,
            locale: 'en-US',
            mode: 'content-free',
        });
        expect(p.aps.alert.title).toBe('Lumastra');
        expect(p.aps.alert.body).toBe('New episode available');
        expect(p.aps.badge).toBe(3);
    });

    it('renders the per-kind body in German', () => {
        const p = buildPushPayload({
            kind: 'library.new_episode',
            notificationId: NID,
            badge: 1,
            locale: 'de-DE',
            mode: 'content-free',
        });
        expect(p.aps.alert.body).toBe('Neue Folge verfügbar');
    });

    it('uses a different body for request.available', () => {
        const en = buildPushPayload({
            kind: 'request.available',
            notificationId: NID,
            badge: 1,
            locale: 'en-US',
            mode: 'content-free',
        });
        const ep = buildPushPayload({
            kind: 'library.new_episode',
            notificationId: NID,
            badge: 1,
            locale: 'en-US',
            mode: 'content-free',
        });
        expect(en.aps.alert.body).not.toBe(ep.aps.alert.body);
    });

    it('never leaks a media title even when one is supplied', () => {
        const p = buildPushPayload({
            kind: 'library.new_episode',
            notificationId: NID,
            badge: 1,
            locale: 'en-US',
            mode: 'content-free',
            mediaTitle: 'Starhaven',
            mediaSubtitle: 'S02E07 is available',
        });
        expect(JSON.stringify(p)).not.toContain('Starhaven');
        expect(JSON.stringify(p)).not.toContain('S02E07');
    });

    it.each([
        ['en', 'You have a new notification.'],
        ['de', 'Du hast eine neue Benachrichtigung.'],
    ])('keeps the Jellyfin notice text out of the relay payload (%s)', (locale, body) => {
        const payload = buildPushPayload({
            kind: 'jellyfin.readonly_token',
            notificationId: NID,
            badge: 1,
            locale,
            mode: 'content-free',
            mediaTitle: 'Your Jellyfin app cannot play with this token',
            mediaSubtitle: 'Private token details',
        });
        expect(payload.aps.alert).toEqual({ title: 'Lumastra', body });
        expect(payload.aps.alert.body).not.toMatch(/Jellyfin|token|play/i);
        expect(JSON.stringify(payload)).not.toContain('Private token details');
    });

    it('falls back to the new-episode body and warns for an unrecognized kind', () => {
        const warn = vi.spyOn(Logger.for('PushPayload'), 'warn');
        const p = buildPushPayload({
            kind: 'social.invite',
            notificationId: NID,
            badge: 1,
            locale: 'en-US',
            mode: 'content-free',
        });
        expect(p.aps.alert.body).toBe('New episode available');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][1]).toMatchObject({ kind: 'social.invite' });
        warn.mockRestore();
    });
});

describe('buildPushPayload — content-ful', () => {
    it('uses the media title and subtitle', () => {
        const p = buildPushPayload({
            kind: 'library.new_episode',
            notificationId: NID,
            badge: 2,
            locale: 'en-US',
            mode: 'content-ful',
            mediaTitle: 'Starhaven',
            mediaSubtitle: 'S02E07 is available',
        });
        expect(p.aps.alert.title).toBe('Starhaven');
        expect(p.aps.alert.body).toBe('S02E07 is available');
    });

    it('falls back to the content-free text when no media title is supplied', () => {
        const p = buildPushPayload({
            kind: 'library.new_episode',
            notificationId: NID,
            badge: 2,
            locale: 'de-DE',
            mode: 'content-ful',
        });
        expect(p.aps.alert.title).toBe('Lumastra');
        expect(p.aps.alert.body).toBe('Neue Folge verfügbar');
    });
});

describe('buildPushPayload — invariants across both modes', () => {
    for (const mode of ['content-free', 'content-ful'] as const) {
        it(`sets mutable-content, data.kind and data.v in ${mode} mode`, () => {
            const p = buildPushPayload({
                kind: 'library.new_episode',
                notificationId: NID,
                badge: 0,
                locale: 'en-US',
                mode,
                mediaTitle: 'X',
                mediaSubtitle: 'Y',
            });
            expect(p.aps['mutable-content']).toBe(1);
            expect(p.data.id).toBe(NID);
            expect(p.data.kind).toBe('library.new_episode');
            expect(p.data.v).toBe(PUSH_PAYLOAD_VERSION);
        });
    }
});

describe('pushExpirationEpochSeconds', () => {
    it('is created_at + 4h, in whole seconds', () => {
        const createdAt = new Date('2026-08-11T13:00:00.000Z');
        expect(pushExpirationEpochSeconds(createdAt)).toBe(
            Math.floor(new Date('2026-08-11T17:00:00.000Z').getTime() / 1000),
        );
    });

    it('does not drift when recomputed later — it is anchored to created_at', () => {
        const createdAt = new Date('2026-08-11T13:00:00.000Z');
        const first = pushExpirationEpochSeconds(createdAt);
        const second = pushExpirationEpochSeconds(createdAt);
        expect(second).toBe(first);
    });
});
