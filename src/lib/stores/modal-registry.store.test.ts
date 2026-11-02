// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

it('signals an explicit request, shares readiness, and clears demand after registration', async () => {
    vi.resetModules();
    const registry = await import('./modal-registry.store');
    expect(get(registry.modalRegistrationRequested)).toBe(false);
    const first = registry.waitForModals();
    expect(get(registry.modalRegistrationRequested)).toBe(true);
    expect(registry.waitForModals()).toBe(first);
    const component = () => ({});
    registry.registerModalComponents({
        movie: component,
        actor: component,
        request: component,
        seasonSelector: component,
        similarMovies: component,
        confirm: component,
        album: component,
        artist: component,
    });
    await first;
    expect(get(registry.modalRegistrationRequested)).toBe(false);
    expect(registry.getModalComponent('movie')).toBe(component);
    await registry.waitForModals();
    expect(get(registry.modalRegistrationRequested)).toBe(false);
});
