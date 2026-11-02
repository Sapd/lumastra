// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { config } from './config.js';
import { configSchema } from '$lib/config/schema.js';

describe('push configuration', () => {
    it('defaults the feature on — push works out of the box via the licence-minted relay token', () => {
        expect(config.FEATURE_PUSH_NOTIFICATIONS).toBe(true);
    });

    it('defaults the relay URL to the official host', () => {
        expect(config.PUSH_RELAY_URL).toBe('https://push.lumastra.org');
    });

    it('keeps config.ts and the admin schema in agreement', () => {
        const flag = configSchema.find((entry) => entry.key === 'FEATURE_PUSH_NOTIFICATIONS');
        expect(flag).toMatchObject({ type: 'boolean', defaultValue: true });
        // The schema default IS what the admin UI renders; if it drifts from the
        // server's default the UI lies about the running configuration.
        expect(flag?.defaultValue).toBe(config.FEATURE_PUSH_NOTIFICATIONS);

        const url = configSchema.find((entry) => entry.key === 'PUSH_RELAY_URL');
        expect(url).toMatchObject({ type: 'string', defaultValue: 'https://push.lumastra.org' });
        expect(url?.defaultValue).toBe(config.PUSH_RELAY_URL);

        const token = configSchema.find((entry) => entry.key === 'PUSH_RELAY_TOKEN');
        expect(token).toMatchObject({ type: 'string', defaultValue: '' });
        expect(token?.defaultValue).toBe(config.PUSH_RELAY_TOKEN);
    });

    it('defaults the relay token to empty — the default relay uses the licence-minted token', () => {
        // A non-empty default would override the minted token (the configured
        // key always wins) and send every install's pushes with one shared
        // bearer.
        expect(config.PUSH_RELAY_TOKEN).toBe('');
    });

    it('defaults every operator signing-key setting to empty', () => {
        // Empty is what makes `auto` mean the relay on a stock install. A
        // non-empty default here would route every install that never
        // configured Apple through a transport that cannot sign.
        expect(config.APNS_KEY_P8).toBe('');
        expect(config.APNS_KEY_P8_PATH).toBe('');
        expect(config.APNS_KEY_ID).toBe('');
        expect(config.APNS_TEAM_ID).toBe('');
    });

    it('defaults the transport to auto', () => {
        expect(config.PUSH_TRANSPORT).toBe('auto');
    });

    it('keeps the direct-APNs keys in agreement with the admin schema', () => {
        for (const key of ['APNS_KEY_P8', 'APNS_KEY_P8_PATH', 'APNS_KEY_ID', 'APNS_TEAM_ID']) {
            const entry = configSchema.find((e) => e.key === key);
            expect(entry, `${key} missing from configSchema`).toBeDefined();
            expect(entry).toMatchObject({ type: 'string', defaultValue: '' });
        }

        const transport = configSchema.find((e) => e.key === 'PUSH_TRANSPORT');
        expect(transport).toMatchObject({ type: 'select', defaultValue: 'auto' });
        expect(transport?.options?.map((o) => o.value)).toEqual(['auto', 'direct', 'relay']);
        expect(transport?.defaultValue).toBe(config.PUSH_TRANSPORT);
    });

    it('marks the Apple signing key sensitive so the admin UI masks it', () => {
        // It is a private key. Rendering it in plain text on an admin screen
        // puts it in screenshots and support bundles.
        const key = configSchema.find((entry) => entry.key === 'APNS_KEY_P8');
        expect(key?.uiHints?.sensitive).toBe(true);
    });

    it('marks the relay token sensitive so the admin UI masks it', () => {
        // It is a bearer credential. Every other secret-shaped key in the
        // schema carries this hint; one that does not renders in plain text on
        // an admin screen and lands in screenshots and support bundles.
        const token = configSchema.find((entry) => entry.key === 'PUSH_RELAY_TOKEN');
        expect(token?.uiHints?.sensitive).toBe(true);
    });
});
