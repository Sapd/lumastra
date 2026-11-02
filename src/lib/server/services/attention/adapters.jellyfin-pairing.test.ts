// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { adaptTaskLiveness, LIVENESS_DOMAIN_PREFIXES } from './adapters.js';
import { ATTENTION_SOURCE_PREFIXES } from './attention-service.js';
import { sectionForItem } from '$lib/shared/attention-section-map.js';

describe('persistent Jellyfin pairing finding', () => {
    it('shows a warning count linked to Jellyfin settings and protected from false resolution', () => {
        const [alert] = adaptTaskLiveness([
            {
                code: 'invariant-amber',
                severity: 'warn',
                subsystem: 'jellyfin-unpaired-watch-records',
                summary: 'stored English copy',
                detail: { value: 4 },
            },
        ]);
        expect(alert.severity).toBe('warning');
        expect(alert.title).toBe('Jellyfin: 4 titles not paired');
        expect(alert.domain).toBe('settings');
        expect(alert.sourceRef).toBe('/admin/settings/connections?category=conn-jellyfin');
        expect(alert.actions[0].href).toBe(alert.sourceRef);
        expect(sectionForItem(alert)).toBe('settings');
        expect(LIVENESS_DOMAIN_PREFIXES.some((prefix) => alert.id.startsWith(prefix))).toBe(true);
        expect(ATTENTION_SOURCE_PREFIXES.some((prefix) => alert.id.startsWith(prefix))).toBe(true);
    });
});
