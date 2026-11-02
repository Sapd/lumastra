// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export function canonicalDetailTab(raw: string | null): { tab: string; section?: string } {
    switch (raw) {
        case 'images':
            return { tab: 'artwork' };
        case 'sync':
            return { tab: 'maintenance', section: 'metadata' };
        case 'pipeline':
            return { tab: 'maintenance', section: 'processing' };
        case 'ordering':
            return { tab: 'episodes', section: 'ordering' };
        case 'health':
            return { tab: 'episodes', section: 'issues' };
        case 'season':
            return { tab: 'episodes' };
        default:
            return { tab: raw ?? 'overview' };
    }
}

export { detailTabPath } from '$lib/components/admin/media/detail-navigation.js';
