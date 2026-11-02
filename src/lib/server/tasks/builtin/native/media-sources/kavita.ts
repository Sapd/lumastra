// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineMediaSource } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import { config } from '$lib/server/config.js';

// NOTE: scan/fullSync are intentional no-ops. Kavita is surfaced via live
// API proxy in src/routes/api/search/+server.ts (lines ~546-590) which calls
// kavita.search() directly against the external server. This stub exists so
// the admin Extensions page can show Kavita as a known media source with
// configuration status — that's its only role. Do not call scan/fullSync
// expecting them to populate media_items; they won't.

export const kavitaMediaSource = defineMediaSource({
    id: 'kavita-media-source',
    name: 'Kavita',
    version: '1.0.0',
    description: 'Book, manga, and comic library from Kavita',
    capabilities: { http: true },
    sourceConfig: {
        supportsIncrementalScan: false,
        defaultScanIntervalHours: 24,
    },
    // No settings of its own: KAVITAURL/KAVITAAPIKEY are host settings
    // (Settings → Providers → Connections), read below via `config`.
    isEnabled: () => config.FEATURE_KAVITA === true,
    isConfigured: () => !!config.KAVITAURL && !!config.KAVITAAPIKEY,
    isAvailable: () => Promise.resolve(!!config.KAVITAURL && !!config.KAVITAAPIKEY),
    async scan(_ctx, _opts) {
        return {
            added: 0,
            updated: 0,
            removed: 0,
            unmatched: 0,
            skipped: 0,
            durationMs: 0,
            errors: [],
        };
    },
    async fullSync(_ctx) {
        return { added: 0, updated: 0, removed: 0, durationMs: 0, errors: [] };
    },
    async getStatus(_ctx) {
        return { itemCount: 0, isScanning: false };
    },
});

registry.registerMediaSource(kavitaMediaSource);
