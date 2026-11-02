// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The module-level service clients are built at import. They used to copy the
 * URL/key into fields, so a connection saved in the admin UI only applied
 * after a restart. Built from functions, they follow the live setting.
 */

import { describe, expect, it } from 'vitest';
import { SonarrClient } from './sonarr';

describe('service clients follow a saved connection', () => {
    it('Sonarr: not configured → configured without rebuilding the client', () => {
        const conn = { url: '', key: '' };
        const client = new SonarrClient(
            () => conn.url,
            () => conn.key,
        );
        expect(client.isConfigured()).toBe(false);

        conn.url = 'http://sonarr:8989/';
        conn.key = 'k';
        expect(client.isConfigured()).toBe(true);
    });

    it('still accepts plain strings for one-off clients', () => {
        expect(new SonarrClient('http://sonarr:8989', 'k').isConfigured()).toBe(true);
    });
});
