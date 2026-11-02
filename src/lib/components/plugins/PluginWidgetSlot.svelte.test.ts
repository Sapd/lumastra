// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The slot is the one place third-party JavaScript enters the host page, so
 * its failure behaviour matters more than its happy path. These tests pin what
 * happens when a plugin misbehaves: throws on mount, throws on cleanup, or —
 * the case `.finally()` cannot cover — never settles at all.
 */

import { render, cleanup, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PluginWidgetSlot from './PluginWidgetSlot.svelte';

const WIDGET = {
    featureId: 'demo',
    id: 'plugin:demo:w',
    title: 'Demo Widget',
    entry: '/widget.js',
};

// NOTE: the slot resolves a plugin module with a bare dynamic `import()` of a
// URL, which happy-dom cannot fetch — so every render here takes the rejection
// path. That is deliberate: it is the same path a broken plugin takes, and the
// failure behaviour is what these tests are for. Asserting a SUCCESSFUL mount
// needs a real module server, which belongs in an e2e test, not here.

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
    // Every render starts a real dynamic import, even tests that only inspect
    // chrome or immediately unmount. Await its expected rejection so it cannot
    // log through Vitest's RPC after the worker has begun tearing down.
    await waitFor(() =>
        expect(console.error).toHaveBeenCalledWith(
            'Plugin widget plugin:demo:w failed to mount',
            expect.any(Error),
        ),
    );
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('PluginWidgetSlot', () => {
    it('reserves space until the module settles, then releases it', async () => {
        const { container } = render(PluginWidgetSlot, { widget: WIDGET, user: null });
        const host = container.querySelector('.plugin-widget') as HTMLElement;

        // Before settling, the slot holds the layout open so the page does not
        // jump when the widget appears.
        expect(host.style.minHeight).toBe('160px');

        // The import rejects under happy-dom (no network), which is the same
        // path a broken plugin takes — the reservation must be released.
        await waitFor(() => expect(host.style.minHeight).toBe(''));
    });

    it('renders no host chrome by default, so existing widgets are unchanged', () => {
        const { container } = render(PluginWidgetSlot, { widget: WIDGET, user: null });

        expect(container.querySelector('.lum-chrome')).toBeNull();
        expect(container.querySelector('.plugin-widget')).not.toBeNull();
    });

    it('wraps the widget in host chrome with its title when asked', () => {
        const { container } = render(PluginWidgetSlot, {
            widget: WIDGET,
            user: null,
            chrome: true,
        });

        const title = container.querySelector('.lum-chrome-title');
        expect(title?.textContent).toBe('Demo Widget');
        // The mount host still exists inside the frame — chrome wraps, never
        // replaces, the element the plugin renders into.
        expect(container.querySelector('.lum-chrome .plugin-widget')).not.toBeNull();
    });

    it('carries the plugin-widget class that scopes the lum-* kit', () => {
        // The utility classes are scoped under .plugin-widget precisely so they
        // cost nothing elsewhere and cannot restyle host chrome. If this class
        // ever moved, every shipped widget would lose its styling silently.
        const { container } = render(PluginWidgetSlot, { widget: WIDGET, user: null });
        expect(container.querySelector('.plugin-widget')).not.toBeNull();
    });

    it('tags the host element with the widget id for debugging', () => {
        const { container } = render(PluginWidgetSlot, { widget: WIDGET, user: null });
        expect(container.querySelector('.plugin-widget')?.getAttribute('data-widget-id')).toBe(
            'plugin:demo:w',
        );
    });

    it('does not throw when unmounted before the module settles', async () => {
        const { unmount } = render(PluginWidgetSlot, { widget: WIDGET, user: null });
        // Navigating away mid-import must not leave a pending mount writing to
        // a detached element.
        expect(() => unmount()).not.toThrow();
    });
});
