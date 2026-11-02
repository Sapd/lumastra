// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

const stores = vi.hoisted(() => ({
    navigating: (() => {
        let value: unknown = null;
        const subscribers = new Set<(next: unknown) => void>();

        return {
            set(next: unknown) {
                value = next;
                subscribers.forEach((subscriber) => subscriber(value));
            },
            subscribe(run: (next: unknown) => void) {
                subscribers.add(run);
                run(value);

                return () => subscribers.delete(run);
            },
        };
    })(),
}));

vi.mock('$app/stores', () => ({
    navigating: stores.navigating,
}));

import NavigationProgressBar from './NavigationProgressBar.svelte';

describe('NavigationProgressBar', () => {
    afterEach(() => {
        stores.navigating.set(null);
        cleanup();
    });

    test('shows when explicit active state is true', () => {
        render(NavigationProgressBar, { active: true });

        expect(screen.getByLabelText(/Loading/)).toBeTruthy();
    });

    test('shows for SvelteKit navigation even when active is false', () => {
        stores.navigating.set({ type: 'goto' });

        render(NavigationProgressBar, { active: false });

        expect(screen.getByLabelText(/Loading/)).toBeTruthy();
    });

    test('hides when neither explicit active state nor navigation is active', () => {
        render(NavigationProgressBar, { active: false });

        expect(screen.queryByLabelText(/Loading/)).toBeNull();
    });
});
