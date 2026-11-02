// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * These switches moved here out of DisplaySection, and their tests moved with
 * them — three of them were left behind asserting against a component that no
 * longer renders any of this, which is how the move surfaced.
 *
 * The precedence rules are the point. `hide_streams` outranks the audiobook
 * switch, which outranks the reciprocal listening tier, mirroring the server's
 * visibility predicate. That ordering had no coverage at all, and it is exactly
 * the kind of thing that regresses silently: a broken precedence chain does not
 * throw, it just shares something the user asked to keep private.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

interface PrivacyPayload {
    hideFromOthers?: boolean;
    shareListeningActivity?: boolean;
    shareAudiobookActivity?: boolean;
    listeningCircleConfigured?: boolean;
}

const { getStreamPrivacy, updateStreamPrivacy } = vi.hoisted(() => ({
    getStreamPrivacy: vi.fn(async () => ({
        data: {
            hideFromOthers: false,
            shareListeningActivity: true,
            shareAudiobookActivity: true,
            listeningCircleConfigured: true,
        } as PrivacyPayload,
    })),
    updateStreamPrivacy: vi.fn(async (body: PrivacyPayload) => ({
        error: null,
        data: {
            hideFromOthers: body.hideFromOthers ?? true,
            shareListeningActivity: body.shareListeningActivity ?? false,
            shareAudiobookActivity: body.shareAudiobookActivity ?? false,
            listeningCircleConfigured: true,
        } as PrivacyPayload,
    })),
}));

vi.mock('$lib/api/user', () => ({ getStreamPrivacy, updateStreamPrivacy }));

import PrivacySection from './PrivacySection.svelte';

/** Point the first read at a specific server state for one render. */
function serverState(payload: PrivacyPayload): void {
    getStreamPrivacy.mockResolvedValueOnce({
        data: {
            hideFromOthers: false,
            shareListeningActivity: true,
            shareAudiobookActivity: true,
            listeningCircleConfigured: true,
            ...payload,
        },
    });
}

/** Toggle renders a native disabled button, not an aria attribute. */
const inert = (el: HTMLElement): boolean => (el as HTMLButtonElement).disabled;

const audiobookSwitch = (): Promise<HTMLElement> =>
    screen.findByRole('switch', { name: /Share audiobook activity/i });
const listeningSwitch = (): Promise<HTMLElement> =>
    screen.findByRole('switch', { name: /Share coarse listening activity/i });

describe('PrivacySection', () => {
    afterEach(() => {
        cleanup();
        getStreamPrivacy.mockClear();
        updateStreamPrivacy.mockClear();
    });

    test('renders the "What others see" group and the hide-my-streams row', () => {
        render(PrivacySection, {});
        expect(screen.getByText(/What others see/)).toBeTruthy();
        expect(screen.getByText(/Hide my streams/i)).toBeTruthy();
    });

    test('missing privacy fields fall back to private defaults', async () => {
        getStreamPrivacy.mockResolvedValueOnce({ data: {} });
        render(PrivacySection, {});
        const hide = await screen.findByRole('switch', { name: /Hide my streams/i });
        await waitFor(() => expect(inert(hide)).toBe(false));
        expect(hide.getAttribute('aria-checked')).toBe('true');
        expect((await audiobookSwitch()).getAttribute('aria-checked')).toBe('false');
        expect((await listeningSwitch()).getAttribute('aria-checked')).toBe('false');
    });

    test('loads reciprocal coarse listening activity enabled and lets the user opt out', async () => {
        render(PrivacySection, {});
        const toggle = await listeningSwitch();
        await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
        await fireEvent.click(toggle);
        expect(updateStreamPrivacy).toHaveBeenCalledWith({ shareListeningActivity: false });
    });

    test('lets the user disable audiobook sharing without hiding movie and TV streams', async () => {
        render(PrivacySection, {});
        const toggle = await audiobookSwitch();
        await waitFor(() => expect(inert(toggle)).toBe(false));
        await fireEvent.click(toggle);
        // Only the audiobook field travels — the master switch is untouched.
        expect(updateStreamPrivacy).toHaveBeenCalledWith({ shareAudiobookActivity: false });
    });

    test('every switch stays inert until the first read lands', () => {
        // A privacy control must never be interactive while showing a value it
        // has not read: a click in that window writes the PLACEHOLDER back as
        // though the user had chosen it.
        getStreamPrivacy.mockImplementationOnce(() => new Promise(() => {}));
        render(PrivacySection, {});
        for (const toggle of screen.getAllByRole('switch')) expect(inert(toggle)).toBe(true);
        expect(updateStreamPrivacy).not.toHaveBeenCalled();
    });

    test('a failed read leaves the switches inert rather than offering a guess', async () => {
        getStreamPrivacy.mockRejectedValueOnce(new Error('offline'));
        render(PrivacySection, {});
        await waitFor(() => expect(getStreamPrivacy).toHaveBeenCalled());
        for (const toggle of screen.getAllByRole('switch')) expect(inert(toggle)).toBe(true);
    });

    test('hiding streams outranks the audiobook switch', async () => {
        serverState({ hideFromOthers: true });
        render(PrivacySection, {});
        const toggle = await audiobookSwitch();
        // Disabled AND shown as off: the master opt-out already covers it, so
        // rendering it as "on" would claim the user is sharing when they are not.
        await waitFor(() => expect(inert(toggle)).toBe(true));
        expect(toggle.getAttribute('aria-checked')).toBe('false');
    });

    test('the audiobook switch outranks the reciprocal listening tier', async () => {
        serverState({ shareAudiobookActivity: false });
        render(PrivacySection, {});
        const toggle = await listeningSwitch();
        await waitFor(() => expect(inert(toggle)).toBe(true));
        await fireEvent.click(toggle);
        expect(updateStreamPrivacy).not.toHaveBeenCalled();
    });

    test('the reciprocal tier needs a listening circle an admin has configured', async () => {
        serverState({ listeningCircleConfigured: false });
        render(PrivacySection, {});
        const toggle = await listeningSwitch();
        await waitFor(() => expect(inert(toggle)).toBe(true));
        await fireEvent.click(toggle);
        expect(updateStreamPrivacy).not.toHaveBeenCalled();
    });

    test('a rejected write rolls the switch back instead of stranding it', async () => {
        render(PrivacySection, {});
        const toggle = await audiobookSwitch();
        await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
        updateStreamPrivacy.mockResolvedValueOnce({
            error: 'nope',
        } as unknown as Awaited<ReturnType<typeof updateStreamPrivacy>>);
        await fireEvent.click(toggle);
        await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    });

    test('a response missing the field keeps the optimistic value, never undefined', async () => {
        // `else if (data)` alone wrote `undefined` here, which renders as "off"
        // and is then saved back as a real choice on the next click.
        render(PrivacySection, {});
        const toggle = await audiobookSwitch();
        await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
        updateStreamPrivacy.mockResolvedValueOnce({ error: null, data: {} });
        await fireEvent.click(toggle);
        await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    });
});
