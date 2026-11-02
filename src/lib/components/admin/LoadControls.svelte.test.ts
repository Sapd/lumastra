// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import LoadControls from './LoadControls.svelte';

vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Load controls playback protection', () => {
    it('shows the playback reason and live encode counts', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async (_input: unknown, _init?: unknown) =>
                    new Response(
                        JSON.stringify({
                            globalPause: { active: false },
                            quietHours: {
                                enabled: false,
                                start: '01:00',
                                end: '07:00',
                                active: false,
                            },
                            playbackPressure: {
                                paused: true,
                                reason: 'cpu_transcode',
                                cpuTranscodes: 1,
                                gpuTranscodes: 2,
                                loadRatioPerCore: 0.8,
                                threshold: 1.25,
                                deferredMinutes: 7,
                            },
                        }),
                    ),
            ),
        );
        render(LoadControls);
        await vi.advanceTimersByTimeAsync(0);
        expect(screen.getByText(m.admin_home_playback_cpu_paused())).toBeTruthy();
        expect(screen.getByText(m.admin_home_playback_cpu_deferred({ minutes: 7 }))).toBeTruthy();
        expect(screen.getByRole('status').textContent).toContain(
            m.admin_home_playback_cpu_encoding(),
        );
        expect(screen.getByRole('status').textContent).toContain(
            m.admin_home_playback_cpu_stats({
                cpu: 1,
                gpu: 2,
                load: '0.80',
                threshold: 1.25,
            }),
        );
        expect(
            screen
                .getByRole('link', { name: m.admin_home_playback_cpu_configure() })
                .getAttribute('href'),
        ).toContain('/admin/settings/tasks');
    });

    it('updates on recovery without resuming an operator pause', async () => {
        let paused = true;
        const fetch = vi.fn(
            async (_input: unknown, _init?: unknown) =>
                new Response(
                    JSON.stringify({
                        globalPause: { active: true, resumeAt: '2026-10-22T12:00:00Z' },
                        quietHours: { enabled: false, start: '01:00', end: '07:00', active: false },
                        playbackPressure: {
                            paused,
                            reason: paused ? 'cooloff' : 'none',
                            cpuTranscodes: 0,
                            gpuTranscodes: 0,
                            loadRatioPerCore: 0.5,
                            threshold: 1.25,
                        },
                    }),
                ),
        );
        vi.stubGlobal('fetch', fetch);
        render(LoadControls);
        await vi.advanceTimersByTimeAsync(0);
        expect(screen.getByRole('status').textContent).toContain(
            m.admin_home_playback_cpu_cooloff(),
        );
        paused = false;
        await vi.advanceTimersByTimeAsync(20_000);
        expect(screen.getByText(m.admin_home_playback_cpu_ready())).toBeTruthy();
        expect(
            screen.getByRole('button', { name: m.admin_home_load_controls_resume_button() }),
        ).toBeTruthy();
        expect(fetch.mock.calls.every((call) => call.length === 1)).toBe(true);
    });
});
