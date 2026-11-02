// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * "Configured" is not "healthy": only a passing probe is green, an
 * unreachable one is red, and an unprobed configured service is neutral.
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ServiceHealthGrid from './ServiceHealthGrid.svelte';

afterEach(cleanup);

function toneOf(container: HTMLElement, label: string): string | null {
    const tile = [...container.querySelectorAll('[data-tone]')].find((el) =>
        el.textContent?.includes(label),
    );
    return tile?.getAttribute('data-tone') ?? null;
}

describe('ServiceHealthGrid', () => {
    it('colours by probe, not by configuration', () => {
        const { container } = render(ServiceHealthGrid, {
            props: {
                services: {
                    sonarr: { configured: true, label: 'Sonarr', probe: { status: 'warn' } },
                    radarr: { configured: true, label: 'Radarr', probe: { status: 'pass' } },
                    tmdb: { configured: true, label: 'TMDB' },
                    mdblist: { configured: false, label: 'MDBList' },
                },
            },
        });

        expect(toneOf(container, 'Sonarr')).toBe('down');
        expect(toneOf(container, 'Radarr')).toBe('up');
        expect(toneOf(container, 'TMDB')).toBe('unchecked');
        expect(toneOf(container, 'MDBList')).toBe('off');
        // Unreachable sorts first.
        expect(container.querySelector('[data-tone]')?.textContent).toContain('Sonarr');
    });
});
