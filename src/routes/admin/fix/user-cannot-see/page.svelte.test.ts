// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * A failed user list must say so (it used to leave an empty picker and a
 * button that never enabled), and "can see" is not the headline for an item
 * Browse does not list.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';

const api = vi.hoisted(() => ({ apiGet: vi.fn(), getLocalUsers: vi.fn() }));
const nav = vi.hoisted(() => ({
    url: new URL(
        'http://localhost/admin/fix/user-cannot-see?mediaId=77777777-7777-7777-7777-777777777701',
    ),
}));
vi.mock('$lib/api/client.js', () => ({ apiGet: api.apiGet }));
vi.mock('$lib/api/admin.js', () => ({ getLocalUsers: api.getLocalUsers }));
vi.mock('$app/state', () => ({ page: nav }));
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return { page: readable({ data: {}, url: nav.url }) };
});
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), goto: vi.fn() }));

import Page from './+page.svelte';

afterEach(() => cleanup());

describe('/admin/fix/user-cannot-see', () => {
    it('a failed user list is shown as an error', async () => {
        api.getLocalUsers.mockResolvedValue({ data: undefined, error: 'boom', status: 500 });
        render(Page);
        await screen.findByRole('button', { name: m.common_retry() });
    });

    it('visible but not browsable is not the green "can see"', async () => {
        api.getLocalUsers.mockResolvedValue({
            data: { items: [{ id: 'u1', username: 'kid' }] },
            error: undefined,
        });
        api.apiGet.mockResolvedValue({
            data: {
                generatedAt: '2026-10-06T10:00:00.000Z',
                userId: 'u1',
                username: 'kid',
                userIsAdmin: false,
                userMaxAgeRating: null,
                userGroups: [],
                mediaId: '77777777-7777-7777-7777-777777777701',
                mediaTitle: 'Film',
                mediaType: 'movie',
                visible: true,
                browsable: false,
                blockedBy: null,
                gates: [],
            },
            error: null,
            status: 200,
        });
        render(Page);
        await screen.findByRole('option', { name: 'kid' });
        await fireEvent.click(screen.getByRole('button', { name: m.admin_fix_visibility_run() }));
        await screen.findByText(
            m.admin_fix_visibility_visible_not_browsable({ username: 'kid', title: 'Film' }),
        );
        expect(
            screen.queryByText(m.admin_fix_visibility_visible({ username: 'kid', title: 'Film' })),
        ).toBeNull();
    });

    it('renders gate explanations from their code, and falls back to detail', async () => {
        api.getLocalUsers.mockResolvedValue({
            data: { items: [{ id: 'u1', username: 'kid' }] },
            error: undefined,
        });
        api.apiGet.mockResolvedValue({
            data: {
                generatedAt: '2026-10-06T10:00:00.000Z',
                userId: 'u1',
                username: 'kid',
                userIsAdmin: false,
                userMaxAgeRating: 6,
                userGroups: [],
                mediaId: '77777777-7777-7777-7777-777777777701',
                mediaTitle: 'Film',
                mediaType: 'movie',
                visible: false,
                browsable: true,
                blockedBy: 'age-rating',
                gates: [
                    {
                        gate: 'age-rating',
                        passed: false,
                        evaluated: true,
                        code: 'age-above',
                        params: { rating: 12, max: 6 },
                        detail: 'english',
                    },
                    {
                        gate: 'account',
                        passed: true,
                        evaluated: true,
                        code: 'from-a-newer-server',
                        params: {},
                        detail: 'English fallback text',
                    },
                ],
            },
            error: null,
            status: 200,
        });
        render(Page);
        await screen.findByRole('option', { name: 'kid' });
        await fireEvent.click(screen.getByRole('button', { name: m.admin_fix_visibility_run() }));
        await screen.findByText(m.admin_fix_visibility_detail_age_above({ rating: 12, max: 6 }));
        expect(screen.getByText('English fallback text')).toBeTruthy();
    });
});
