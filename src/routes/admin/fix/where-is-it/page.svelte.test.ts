// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Only a `?q=` deep link searches on arrival. Typing used to fire a search on
 * the second keystroke and then disable the button, so the operator's full
 * query was ignored and results for "Sh" showed under "Shutter Island".
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';

const api = vi.hoisted(() => ({ apiGet: vi.fn() }));
const nav = vi.hoisted(() => ({ url: new URL('http://localhost/admin/fix/where-is-it') }));
vi.mock('$lib/api/client.js', () => api);
vi.mock('$app/state', () => ({ page: nav }));
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return { page: readable({ data: {}, url: nav.url }) };
});
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), goto: vi.fn() }));

import Page from './+page.svelte';

const EMPTY = {
    generatedAt: '2026-10-06T10:00:00.000Z',
    query: 'x',
    matches: [],
    truncated: false,
    quarantined: [],
    lastScanCompletedAt: null,
    scanEnabled: null,
    unreadable: [],
};

beforeEach(() => {
    api.apiGet.mockReset();
    api.apiGet.mockResolvedValue({ data: EMPTY, error: null, status: 200 });
});

afterEach(() => cleanup());

describe('/admin/fix/where-is-it', () => {
    it('typing does not search until the form is submitted', async () => {
        nav.url = new URL('http://localhost/admin/fix/where-is-it');
        render(Page);
        const input = screen.getByPlaceholderText(m.admin_fix_where_placeholder());
        await fireEvent.input(input, { target: { value: 'Sh' } });
        await fireEvent.input(input, { target: { value: 'Shutter' } });
        expect(api.apiGet).not.toHaveBeenCalled();
        await fireEvent.click(screen.getByRole('button', { name: m.admin_fix_where_run() }));
        expect(api.apiGet).toHaveBeenCalledTimes(1);
        expect(api.apiGet.mock.calls[0]?.[0]).toContain('q=Shutter');
    });

    it('a ?q= deep link searches once on arrival', async () => {
        nav.url = new URL('http://localhost/admin/fix/where-is-it?q=Amelie');
        render(Page);
        await screen.findByText(m.admin_fix_where_none_title({ query: 'x' }));
        expect(api.apiGet).toHaveBeenCalledTimes(1);
        expect(api.apiGet.mock.calls[0]?.[0]).toContain('q=Amelie');
    });

    it('renders step explanations from their code, and falls back to detail', async () => {
        nav.url = new URL('http://localhost/admin/fix/where-is-it?q=Amelie');
        api.apiGet.mockResolvedValue({
            data: {
                ...EMPTY,
                matches: [
                    {
                        mediaItemId: 'i1',
                        title: 'Amelie',
                        mediaType: 'movie',
                        filePath: '/m/a.mkv',
                        fileSizeBytes: 1,
                        fileMissing: false,
                        steps: [
                            {
                                step: 'stages-processed',
                                status: 'blocked',
                                code: 'stages-gave-up',
                                params: { count: 1, total: 3, stages: 'trickplay-generation' },
                                detail: 'english',
                            },
                            {
                                step: 'item-visible',
                                status: 'ok',
                                code: 'from-a-newer-server',
                                params: {},
                                detail: 'English fallback text',
                            },
                        ],
                        stoppedAt: 'stages-processed',
                        stages: [],
                    },
                ],
            },
            error: null,
            status: 200,
        });
        render(Page);
        await screen.findByText(
            m.admin_fix_where_detail_stages_gave_up({
                count: 1,
                total: 3,
                stages: 'trickplay-generation',
            }),
        );
        expect(screen.getByText('English fallback text')).toBeTruthy();
    });
});
