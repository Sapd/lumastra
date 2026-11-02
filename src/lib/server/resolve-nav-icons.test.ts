// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { resolveNavIcons } from './resolve-nav-icons';

describe('resolveNavIcons', () => {
    it('resolves a configured heroicon name to its real IconSource', () => {
        const resolved = resolveNavIcons(['film']);
        expect(resolved.film).toBeDefined();
        expect(resolved.film).toHaveProperty('default');
    });

    it('resolves a configured Lumastra custom icon name to its real IconSource', () => {
        const resolved = resolveNavIcons(['clapperboard']);
        expect(resolved.clapperboard).toBeDefined();
        expect(resolved.clapperboard).toHaveProperty('default');
    });

    it('does NOT resolve names nothing configured — the whole point of resolving server-side', () => {
        const resolved = resolveNavIcons(['film']);
        // 'trash' and 'key' are real navigationIconMap keys, but were never
        // passed in — must not silently ride along.
        expect(resolved).not.toHaveProperty('trash');
        expect(resolved).not.toHaveProperty('key');
        expect(Object.keys(resolved)).toEqual(['film']);
    });

    it('skips a custom icon path (served as an <img src>, not a lookup)', () => {
        const resolved = resolveNavIcons(['/icons/home.svg', 'https://example.com/x.png', 'film']);
        expect(resolved).toEqual({ film: resolved.film });
    });

    it('skips blank/undefined/null names without throwing', () => {
        const resolved = resolveNavIcons([undefined, null, '', 'film']);
        expect(Object.keys(resolved)).toEqual(['film']);
    });

    it('silently drops an unknown icon name (matches the client\'s existing "missing = no icon" fallback)', () => {
        const resolved = resolveNavIcons(['this-icon-does-not-exist', 'film']);
        expect(Object.keys(resolved)).toEqual(['film']);
    });

    it('de-duplicates repeated names', () => {
        const resolved = resolveNavIcons(['film', 'film', 'film']);
        expect(Object.keys(resolved)).toEqual(['film']);
    });

    it("resolves the legacy chart-bar-square alias under ITS OWN key, from chart-bar's icon", () => {
        const resolved = resolveNavIcons(['chart-bar-square']);
        const direct = resolveNavIcons(['chart-bar']);
        expect(resolved['chart-bar-square']).toBeDefined();
        expect(resolved['chart-bar-square']).toEqual(direct['chart-bar']);
        // The alias must not also leak the modern key in.
        expect(resolved).not.toHaveProperty('chart-bar');
    });
});
