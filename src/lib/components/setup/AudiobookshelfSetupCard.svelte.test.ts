// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The wizard's Audiobookshelf card: connect (URL + key to the setup endpoint),
 * list the stored server's libraries with the addable ones preselected, then add
 * them one by one through /api/setup/library and hand each to the page. A stored
 * connection skips the form; a failed connect shows a fixed message per reason.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
    apiPost: vi.fn(),
    getRemoteLibraries: vi.fn(),
}));
vi.mock('$lib/api/client.js', () => ({ apiPost: api.apiPost }));
vi.mock('$lib/api/admin', () => ({ getRemoteLibraries: api.getRemoteLibraries }));

import type { z } from 'zod';

import AudiobookshelfSetupCard from './AudiobookshelfSetupCard.svelte';

const BASE = {
    provider: 'audiobookshelf',
    label: 'AudiobookShelf',
    mediaType: 'audiobook',
    settingsHref: '/admin/settings/audiobookshelf',
    requiredKeys: ['AUDIOURL', 'AUDIOAPIKEY'],
};

function lib(id: string, name: string, extra: Record<string, unknown> = {}) {
    return { id, name, kind: 'book', supported: true, path: `abs://${id}`, ...extra };
}

const NOT_CONFIGURED = {
    data: { ...BASE, status: 'not_configured', missingKeys: ['AUDIOURL', 'AUDIOAPIKEY'] },
    error: null,
};
const LISTING = {
    data: {
        ...BASE,
        status: 'ok',
        libraries: [
            lib('lib-en', 'Audiobooks'),
            lib('lib-de', 'Hörbücher'),
            lib('lib-pod', 'Podcasts', { kind: 'podcast', supported: false }),
            lib('lib-old', 'Already here', {
                existing: {
                    libraryPathId: 'p1',
                    libraryGroupId: 'g1',
                    language: 'en',
                    enabled: true,
                },
            }),
        ],
    },
    error: null,
};

beforeEach(() => {
    api.apiPost.mockReset();
    api.getRemoteLibraries.mockReset();
});
afterEach(() => cleanup());

function setup(addedIds: string[] = []) {
    const onadded = vi.fn();
    const onconnected = vi.fn();
    const onbusy = vi.fn();
    const onpending = vi.fn();
    const view = render(AudiobookshelfSetupCard, {
        props: { addedIds, onadded, onconnected, onbusy, onpending },
    });
    // The card has no Add button of its own: the library step's Continue
    // calls addPending(), so ticked libraries are never left behind.
    const addPending = () =>
        (view.component as unknown as { addPending: () => Promise<boolean> }).addPending();
    return { ...view, onadded, onconnected, onbusy, onpending, addPending };
}

async function fillAndConnect(view: { container: HTMLElement }) {
    const urlInput = view.container.querySelector('#abs-url') as HTMLInputElement;
    const keyInput = view.container.querySelector('#abs-key') as HTMLInputElement;
    await fireEvent.input(urlInput, { target: { value: 'http://abs.lan:13378' } });
    await fireEvent.input(keyInput, { target: { value: 'secret-key' } });
    const form = view.container.querySelector('form') as HTMLFormElement;
    await fireEvent.submit(form);
}

describe('AudiobookshelfSetupCard', () => {
    it.each([
        [
            {
                userMatchStatus: 'ok',
                adminUsername: 'admin',
                adminMatched: false,
                matchedName: null,
                matchedUsernames: [],
                unmatchedUsernames: [],
                pendingUsernames: ['admin'],
            },
            ['admin', 'first playback', 'No action'],
        ],
        [
            {
                userMatchStatus: 'ok',
                adminUsername: 'admin',
                adminMatched: true,
                matchedName: 'ADMIN',
                matchedUsernames: ['admin'],
                unmatchedUsernames: ['bob'],
            },
            ['ADMIN', 'bob', 'skipped'],
        ],
        [
            {
                userMatchStatus: 'ok',
                adminUsername: 'admin',
                adminMatched: false,
                matchedName: null,
                matchedUsernames: [],
                unmatchedUsernames: ['admin'],
            },
            ['admin', 'skipped'],
        ],
        [
            { userMatchStatus: 'unavailable', adminUsername: 'admin', adminMatched: null },
            ['could not check', 'administrator'],
        ],
    ])(
        'shows actionable listening-sync feedback after connecting (%j)',
        async (match, expected) => {
            api.getRemoteLibraries.mockResolvedValueOnce(NOT_CONFIGURED).mockResolvedValue(LISTING);
            api.apiPost.mockResolvedValue({
                data: { connected: true, libraryCount: 2, ...match },
                error: null,
            });
            const view = setup();
            await waitFor(() => expect(api.getRemoteLibraries).toHaveBeenCalledTimes(1));
            await fillAndConnect(view);
            await waitFor(() => {
                for (const text of expected) expect(view.container.textContent).toContain(text);
            });
            expect(view.container.textContent).not.toContain('secret-key');
        },
    );

    it('connects, lists libraries with the addable ones checked, and adds them', async () => {
        api.getRemoteLibraries.mockResolvedValueOnce(NOT_CONFIGURED).mockResolvedValue(LISTING);
        api.apiPost.mockImplementation(
            async (endpoint: string, _schema: unknown, body: { remoteLibraryId?: string }) => {
                if (endpoint === '/api/setup/audiobookshelf') {
                    return { data: { connected: true, libraryCount: 2 }, error: null };
                }
                return { data: { ok: true, runId: `run-${body.remoteLibraryId}` }, error: null };
            },
        );

        const view = setup();
        await waitFor(() => expect(api.getRemoteLibraries).toHaveBeenCalledTimes(1));
        expect(view.onconnected).not.toHaveBeenCalled();

        await fillAndConnect(view);
        expect(api.apiPost).toHaveBeenCalledWith('/api/setup/audiobookshelf', expect.anything(), {
            url: 'http://abs.lan:13378',
            apiKey: 'secret-key',
        });

        const schema = api.apiPost.mock.calls.find(
            ([path]) => path === '/api/setup/audiobookshelf',
        )![1] as z.ZodObject;
        expect(schema.strict().safeParse({ connected: true, libraryCount: 2 }).success).toBe(true);

        await waitFor(() => expect(view.getByText('Audiobooks')).toBeTruthy());
        const box = (id: string) =>
            view.container.querySelector(`#abs-lib-${id}`) as HTMLInputElement;
        expect(box('lib-en').checked).toBe(true);
        expect(box('lib-de').checked).toBe(true);
        // Unsupported kinds and libraries that already exist cannot be picked.
        expect(box('lib-pod').disabled).toBe(true);
        expect(box('lib-pod').checked).toBe(false);
        expect(box('lib-old').disabled).toBe(true);

        // Uncheck one; the page is told one library is pending, then adds it.
        await fireEvent.click(box('lib-de'));
        await waitFor(() => expect(view.onpending).toHaveBeenLastCalledWith(1));
        expect(view.getByText('Ticked libraries are added when you continue.')).toBeTruthy();
        expect(await view.addPending()).toBe(true);

        await waitFor(() => expect(view.onadded).toHaveBeenCalledTimes(1));
        expect(api.apiPost).toHaveBeenCalledWith('/api/setup/library', expect.anything(), {
            provider: 'audiobookshelf',
            remoteLibraryId: 'lib-en',
            mediaType: 'audiobook',
        });
        expect(view.onadded).toHaveBeenCalledWith({
            remoteLibraryId: 'lib-en',
            name: 'Audiobooks',
            runId: 'run-lib-en',
        });
        // The key does not linger in the form after it was stored.
        expect(view.container.querySelector('#abs-key')).toBeNull();
    });

    it('skips the form when a stored connection already answers', async () => {
        api.getRemoteLibraries.mockResolvedValue(LISTING);
        const view = setup(['lib-en']);
        await waitFor(() => expect(view.onconnected).toHaveBeenCalledTimes(1));
        expect(view.container.querySelector('#abs-url')).toBeNull();
        const en = view.container.querySelector('#abs-lib-lib-en') as HTMLInputElement;
        // Added earlier in this wizard run: shown as done.
        expect(en.checked).toBe(true);
        expect(en.disabled).toBe(true);
    });

    it.each([
        [{ connected: false, reason: 'auth' }, /rejected the API key/],
        [{ connected: false, reason: 'http', httpStatus: 502 }, /HTTP 502/],
        [{ connected: false, reason: 'not_audiobookshelf' }, /did not answer like/],
        [{ connected: false, reason: 'network' }, /Couldn't reach Audiobookshelf/],
        [
            {
                connected: false,
                reason: 'network',
                error: 'TLS certificate error. Add your CA via NODE_EXTRA_CA_CERTS.',
            },
            /NODE_EXTRA_CA_CERTS/,
        ],
        [{ connected: false, reason: 'env_locked', keys: ['AUDIOURL'] }, /AUDIOURL/],
        [{ connected: false, reason: 'libraries_exist' }, /already exist/],
    ])('shows a message and stays on the form for %o', async (response, message) => {
        api.getRemoteLibraries.mockResolvedValue(NOT_CONFIGURED);
        api.apiPost.mockResolvedValue({ data: response, error: null });
        const view = setup();
        await waitFor(() => expect(api.getRemoteLibraries).toHaveBeenCalled());
        await fillAndConnect(view);
        await waitFor(() => expect(view.getByRole('alert').textContent).toMatch(message));
        expect(view.container.querySelector('#abs-url')).not.toBeNull();
        // Only the mount-time check listed anything.
        expect(api.getRemoteLibraries).toHaveBeenCalledTimes(1);
    });

    it('stops at the first library that cannot be added and says which', async () => {
        api.getRemoteLibraries.mockResolvedValue(LISTING);
        api.apiPost.mockResolvedValue({ data: null, error: 'Queue is full' });
        const view = setup();
        await waitFor(() => expect(view.onconnected).toHaveBeenCalled());
        expect(await view.addPending()).toBe(false);
        await waitFor(() => expect(view.getByRole('alert').textContent).toContain('Audiobooks'));
        expect(api.apiPost).toHaveBeenCalledTimes(1);
        expect(view.onadded).not.toHaveBeenCalled();
    });

    it('keeps the key when the server is stored but the listing then fails', async () => {
        api.getRemoteLibraries.mockResolvedValue(NOT_CONFIGURED);
        api.apiPost.mockResolvedValue({ data: { connected: true, libraryCount: 1 }, error: null });
        const view = setup();
        await waitFor(() => expect(api.getRemoteLibraries).toHaveBeenCalledTimes(1));
        await fillAndConnect(view);
        await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
        const key = view.container.querySelector('#abs-key') as HTMLInputElement;
        expect(key.value).toBe('secret-key');
    });

    it('gives a reason when the server refuses a library without an error text', async () => {
        api.getRemoteLibraries.mockResolvedValue(LISTING);
        api.apiPost.mockResolvedValue({ data: { ok: false }, error: null });
        const view = setup();
        await waitFor(() => expect(view.onconnected).toHaveBeenCalled());
        expect(await view.addPending()).toBe(false);
        await waitFor(() => expect(view.getByRole('alert').textContent).toContain('Try again'));
        // The page was told the card was busy, then released.
        expect(view.onbusy).toHaveBeenCalledWith(true);
        expect(view.onbusy).toHaveBeenLastCalledWith(false);
    });
});
