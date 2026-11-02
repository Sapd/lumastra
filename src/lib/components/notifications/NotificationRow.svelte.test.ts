// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * NotificationRow — how a row's `link` becomes something clickable.
 *
 * Only the routing branch is covered here, because it is the only part of this
 * component with a decision in it: three of the four `link.target` values are
 * IN-APP (resolved through `$lib/paths`' `resolve()` and SvelteKit's client
 * router), and `'url'` deliberately is not. Getting that distinction wrong is
 * invisible in a screenshot and expensive in production — an absolute URL put
 * through `resolve()` is mangled into a broken in-app path, and an external
 * anchor without `rel="noopener"` hands the opened page control of this tab
 * (reverse tabnabbing) for an address an operator typed.
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NotificationRow from './NotificationRow.svelte';
import type { InboxNotificationItem } from '$lib/schemas/notifications-types';

afterEach(cleanup);

function makeItem(overrides: Partial<InboxNotificationItem> = {}): InboxNotificationItem {
    return {
        id: 'n1',
        kind: 'admin.broadcast',
        display: { title: 'Maintenance on Sunday' },
        payload: null,
        readAt: null,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        ...overrides,
    };
}

function renderRow(item: InboxNotificationItem) {
    return render(NotificationRow, {
        props: { item, onMarkRead: vi.fn(), onRemove: vi.fn(), onNavigate: vi.fn() },
    });
}

describe('NotificationRow — link routing', () => {
    it('renders a target:url link as an external anchor, verbatim', () => {
        const { container } = renderRow(
            makeItem({ link: { target: 'url', url: 'https://lumastra.org/status' } }),
        );

        const anchor = container.querySelector('a');
        expect(anchor).not.toBeNull();
        // The address as stored — NOT run through `resolve()`, which would
        // prefix the app's base path onto an absolute URL.
        expect(anchor!.getAttribute('href')).toBe('https://lumastra.org/status');
        expect(anchor!.getAttribute('target')).toBe('_blank');
        // Both tokens, and this assertion is the reason this file exists:
        // `noopener` is what stops the opened page steering this tab through
        // `window.opener`.
        const rel = anchor!.getAttribute('rel') ?? '';
        expect(rel).toContain('noopener');
        expect(rel).toContain('noreferrer');
    });

    it('keeps an in-app link in-app — no new tab, no rel', () => {
        const { container } = renderRow(
            makeItem({ kind: 'request.available', link: { target: 'media', mediaId: 'm1' } }),
        );

        const anchor = container.querySelector('a');
        expect(anchor).not.toBeNull();
        expect(anchor!.getAttribute('href')).toContain('modal=m1');
        // A SPA navigation: opening the app's own modal in a new tab would drop
        // the drawer, the router state and the mark-read that rides with it.
        expect(anchor!.getAttribute('target')).toBeNull();
    });

    it('renders a url link with a rejected scheme as a non-navigable row', () => {
        const { container } = renderRow(
            makeItem({ link: { target: 'url', url: 'javascript:alert(1)' } }),
        );

        // No anchor at all — the row falls back to the mark-read button, the
        // same treatment an unrecognized future target gets. A `javascript:`
        // href would execute in this app's origin.
        expect(container.querySelector('a')).toBeNull();
        expect(container.querySelector('button')).not.toBeNull();
    });

    it('renders a linkless announcement as a readable, non-navigable row', () => {
        const { container, getByText } = renderRow(makeItem());

        expect(container.querySelector('a')).toBeNull();
        expect(getByText('Maintenance on Sunday')).toBeTruthy();
    });
});
