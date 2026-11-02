// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import WebhookList from './WebhookList.svelte';
vi.mock('$lib/api/client.js', () => ({ apiPost: vi.fn() }));
afterEach(cleanup);
it('shows delivery failure and dead count instead of a green active indicator', () => {
    const { container } = render(WebhookList, {
        webhooks: [
            {
                id: 'hook',
                url: 'https://example.com',
                active: true,
                eventFilter: [],
                createdAt: '2026-01-01T00:00:00Z',
                lastStatus: 410,
                lastError: 'HTTP 410: endpoint removed',
                deadCount: 2,
            },
        ] as never,
        onEdit: vi.fn(),
        onDelete: vi.fn(),
    });
    expect(screen.getByText('Delivery failed')).toBeTruthy();
    expect(screen.getByText(/endpoint removed/)).toBeTruthy();
    expect(screen.getByText(/2.*dead/)).toBeTruthy();
    expect(container.querySelector('.bg-green-400')).toBeNull();
});
it('keeps failures visible on an inactive hook', () => {
    render(WebhookList, {
        webhooks: [
            {
                id: 'hook',
                url: 'https://example.com',
                active: false,
                eventFilter: [],
                createdAt: '2026-01-01T00:00:00Z',
                lastStatus: 500,
                deadCount: 1,
            },
        ] as never,
        onEdit: vi.fn(),
        onDelete: vi.fn(),
    });
    expect(screen.getByText('Delivery failed')).toBeTruthy();
});

it('shows a recovered hook as active even while historical dead rows are retained', () => {
    const { container } = render(WebhookList, {
        webhooks: [
            {
                id: 'recovered',
                url: 'https://example.com',
                active: true,
                eventFilter: [],
                createdAt: '2026-01-01T00:00:00Z',
                lastStatus: 204,
                lastDeliveredAt: '2026-01-03T00:00:00Z',
                deadCount: 2,
            },
        ] as never,
        onEdit: vi.fn(),
        onDelete: vi.fn(),
    });
    expect(screen.queryByText('Delivery failed')).toBeNull();
    expect(container.querySelector('.bg-green-400')).toBeTruthy();
});
