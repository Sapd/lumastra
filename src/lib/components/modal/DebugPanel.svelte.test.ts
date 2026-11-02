// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import DebugPanel from './DebugPanel.svelte';

describe('Jellyfin debug link', () => {
    it.each(['jellyfin.local', 'jellyfin.local:8096'])(
        'hides invalid URL %s without crashing',
        (base) => {
            render(DebugPanel, {
                mediaType: 'movie',
                title: 'Path fixture',
                jellyfinId: 'item',
                jellyfinUrl: base,
                sonarrUrl: '',
                radarrUrl: '',
                jellyseerrUrl: '',
                onclose: vi.fn(),
            });
            expect(screen.getByText('Path fixture')).toBeTruthy();
            expect(screen.queryByRole('link', { name: 'Jellyfin' })).toBeNull();
        },
    );

    it.each(['https://proxy/jellyfin/', 'https://proxy/jellyfin/?tenant=one'])(
        'appends the web path before the query for %s',
        (base) => {
            render(DebugPanel, {
                mediaType: 'movie',
                title: 'Path fixture',
                jellyfinId: 'item',
                jellyfinUrl: base,
                sonarrUrl: '',
                radarrUrl: '',
                jellyseerrUrl: '',
                onclose: vi.fn(),
            });
            const url = new URL(
                screen.getByRole('link', { name: 'Jellyfin' }).getAttribute('href')!,
            );
            expect(url.pathname).toBe('/jellyfin/web/index.html');
            expect(url.hash).toBe('#!/details?id=item');
            if (base.includes('?')) expect(url.searchParams.get('tenant')).toBe('one');
        },
    );
});
