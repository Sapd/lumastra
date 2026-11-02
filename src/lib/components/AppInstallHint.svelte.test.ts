// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { InstallHintEnv } from './app-install-hint';

const fakeEnv: { current: InstallHintEnv } = {
    current: {
        userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
        platform: 'iPhone',
        maxTouchPoints: 5,
        protocol: 'https:',
        standalone: false,
    },
};

vi.mock('./app-install-hint', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./app-install-hint')>();
    return { ...actual, readInstallHintEnv: () => fakeEnv.current };
});

import AppInstallHint from './AppInstallHint.svelte';
import { DISMISS_KEY } from './app-install-hint';
import { IOS_APP } from '$lib/native-apps';

describe('AppInstallHint', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it('shows the TestFlight link on iPhone Safari', () => {
        render(AppInstallHint, { enabled: true });
        flushSync();
        const link = screen.getByRole('link', { name: 'Get the app' });
        expect(link.getAttribute('href')).toBe(IOS_APP.testFlightUrl);
        expect(link.getAttribute('target')).toBe('_blank');
        expect(
            screen.getByText(/also available as an app for iPhone, iPad and Apple TV/),
        ).toBeTruthy();
    });

    it('renders nothing when the admin setting is off', () => {
        render(AppInstallHint, { enabled: false });
        flushSync();
        expect(screen.queryByRole('link', { name: 'Get the app' })).toBeNull();
    });

    it('closes and stays closed after dismiss', async () => {
        render(AppInstallHint, { enabled: true });
        flushSync();
        await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        flushSync();
        expect(screen.queryByRole('link', { name: 'Get the app' })).toBeNull();
        expect(localStorage.getItem(DISMISS_KEY)).not.toBeNull();

        cleanup();
        render(AppInstallHint, { enabled: true });
        flushSync();
        expect(screen.queryByRole('link', { name: 'Get the app' })).toBeNull();
    });

    it('still renders and closes when storage throws (private mode)', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        render(AppInstallHint, { enabled: true });
        flushSync();
        await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        flushSync();
        expect(screen.queryByRole('link', { name: 'Get the app' })).toBeNull();
    });
});
