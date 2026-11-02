// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attentionItem } from '$lib/shared/__fixtures__/attention-section-ids.js';
import * as m from '$lib/paraglide/messages.js';

const store = vi.hoisted(() => ({
    payload: {
        verdict: 'healthy',
        generatedAt: new Date().toISOString(),
        library: { totalItems: 0 },
        system: { databaseHealthy: true },
        sessions: { count: 0, preview: [] },
        tasks: { running: 0, ranToday: 0 },
        users: { total: 1 },
        attention: { items: [] as unknown[] },
    },
    loading: false,
    start: vi.fn(),
    stop: vi.fn(),
    refresh: vi.fn(),
    ack: vi.fn(),
}));
vi.mock('$lib/stores/admin-status.store.svelte.js', () => ({ adminStatus: store }));
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return { page: readable({ url: new URL('http://localhost/admin'), data: {} }) };
});
import Page from './+page.svelte';

beforeEach(() => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) =>
            input.includes('nightly-digest')
                ? Response.json({
                      windowHours: 12,
                      totalCompletedRuns: 1,
                      completed: [
                          {
                              taskId: 'media-probe',
                              taskName: 'File details',
                              runs: 1,
                              itemsProcessed: 1,
                          },
                      ],
                      stillGoing: [],
                      failedCount: 0,
                  })
                : new Response(null, { status: 503 }),
        ),
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

it('keeps optional unconfigured providers out of Home attention and the digest', async () => {
    store.payload.attention.items = [
        attentionItem({
            id: 'provider:lastfm',
            severity: 'info',
            title: 'Optional Last.fm is not configured',
        }),
    ];
    render(Page, { data: {} as never });
    await screen.findByText(m.admin_home_digest_total_runs({ count: 1, hours: 12 }));
    expect(screen.queryByText(m.admin_home_digest_needs_you_heading())).toBeNull();
    expect(screen.queryByText('Optional Last.fm is not configured')).toBeNull();
    expect(screen.getByText(m.admin_ops_attention_empty())).toBeTruthy();
});
