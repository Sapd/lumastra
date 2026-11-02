// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick, type ComponentProps } from 'svelte';
import type { SubmitFunction } from '@sveltejs/kit';
import type { BeforeNavigate } from '@sveltejs/kit';
import type { SectionDefinition, SettingDefinition } from '$lib/config/schema';
import { page } from '$app/state';
import PlaybackSettings from '../../../../routes/admin/settings/playback/+page.svelte';

const fixture = vi.hoisted(() => ({
    sections: [
        {
            id: 'ffmpeg-hardware',
            label: 'Hardware acceleration (GPU)',
            description: 'Hardware controls',
            order: 1,
        },
    ] satisfies SectionDefinition[],
    settings: [
        {
            key: 'GPU_ACCELERATION',
            type: 'select',
            label: 'GPU Acceleration',
            description: 'Encoder',
            defaultValue: 'none',
            section: 'ffmpeg-hardware',
            validation: {
                options: [
                    { value: 'none', label: 'None' },
                    { value: 'qsv', label: 'Intel Quick Sync' },
                ],
            },
        },
        {
            key: 'HW_ENCODING_ENABLED',
            type: 'boolean',
            label: 'Hardware Encoding',
            description: 'Enable encoding',
            defaultValue: false,
            section: 'ffmpeg-hardware',
        },
    ] satisfies SettingDefinition[],
    beforeNavigate: undefined as ((navigation: BeforeNavigate) => void) | undefined,
    goto: vi.fn(),
    enhanceCallbacks: new Map<string, SubmitFunction>(),
}));

vi.mock('$app/state', async () => {
    const { SvelteURL } = await import('svelte/reactivity');
    const { writable, fromStore } = await import('svelte/store');
    const state = fromStore(writable<App.PageState>({}));
    return {
        page: {
            url: new SvelteURL('http://localhost/admin/settings/general'),
            get state() {
                return state.current;
            },
            set state(value: App.PageState) {
                state.current = value;
            },
        },
    };
});
vi.mock('$app/navigation', async () => {
    const { page } = await import('$app/state');
    return {
        beforeNavigate: (callback: (navigation: BeforeNavigate) => void): void => {
            fixture.beforeNavigate = callback;
        },
        afterNavigate: vi.fn(),
        goto: fixture.goto,
        pushState: (_url: URL, state: App.PageState): void => {
            page.state = state;
        },
        replaceState: (_url: URL, state: App.PageState): void => {
            page.state = state;
        },
    };
});
vi.mock('$app/forms', () => ({
    enhance: (form: HTMLFormElement, callback: SubmitFunction): object => {
        fixture.enhanceCallbacks.set(form.getAttribute('action') ?? '', callback);
        return { destroy(): void {} };
    },
}));
vi.mock('$lib/paths', () => ({ resolve: (path: string): string => path }));
vi.mock('$lib/config/schema', () => ({
    configSchema: fixture.settings,
    configSections: fixture.sections,
    getSettingsBySection: (id: string): SettingDefinition[] =>
        fixture.settings.filter((s) => s.section === id),
    getVisibleSettingsBySection: (id: string): SettingDefinition[] =>
        fixture.settings.filter((s) => s.section === id),
    isSettingVisible: (): boolean => true,
    isSettingEnabled: (): boolean => true,
}));
// Use actual section/input/save/dialog components, without importing the whole admin barrel.
vi.mock('$lib/components/admin', async () => ({
    SettingSection: (await import('../SettingSection.svelte')).default,
    StickySaveBar: (await import('./StickySaveBar.svelte')).default,
    SearchInput: (await import('./SearchInput.svelte')).default,
    ActionModal: (await import('../ActionModal.svelte')).default,
}));
const api = vi.hoisted(() => ({ detect: vi.fn(), metrics: vi.fn() }));
vi.mock('$lib/api/client.js', () => ({ apiGet: api.detect }));
vi.mock('$lib/api/admin.js', () => ({
    getSystemMetrics: api.metrics,
    checkProviderHealth: vi.fn(),
}));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('$lib/stores/admin-show-advanced.store', async () => {
    const { writable } = await import('svelte/store');
    return { showAdvancedSettings: writable(false) };
});
// Read the source catalog so these tests don't require regenerating shared translations.
vi.mock('$lib/paraglide/messages.js', async () => {
    const { default: messages } = await import('../../../../../messages/en.json');
    return Object.fromEntries(
        Object.entries(messages).map(([key, value]) => [
            key,
            (args: Record<string, string | number> = {}): string =>
                String(value).replace(/\{(\w+)\}/g, (_, name: string) =>
                    String(args[name] ?? `{${name}}`),
                ),
        ]),
    );
});
vi.mock('$lib/utils/admin/settings-highlight', () => ({
    scrollToSetting: vi.fn(
        async ({
            sectionId,
            expandSection,
        }: {
            sectionId: string;
            expandSection: (id: string) => void;
        }): Promise<boolean> => {
            expandSection(sectionId);
            await tick();
            return true;
        },
    ),
}));

function updates(container: HTMLElement): Record<string, unknown> {
    const form = container.querySelector<HTMLFormElement>('form[action="?/save"]');
    if (!form) throw new Error('Missing real settings save form');
    return JSON.parse(String(new FormData(form).get('updates'))) as Record<string, unknown>;
}

afterEach(cleanup);
beforeEach(() => {
    page.url.href = 'http://localhost/admin/settings/playback?category=ffmpeg-hardware';
    page.state = {};
    api.detect.mockResolvedValue({
        data: {
            hostname: 'detect-replica',
            ffmpegReady: true,
            recommended: 'qsv',
            candidates: [{ accel: 'qsv', encoder: 'h264_qsv', vendor: 'Intel', works: true }],
        },
    });
    api.metrics.mockResolvedValue({
        data: {
            hostname: 'status-replica',
            gpu: { configured: 'none', detected: false, accessible: false },
        },
    });
});

it('applies detection through the real playback snippet, controls and serialized settings form, then supports discard and reapply', async () => {
    const data = {
        values: { GPU_ACCELERATION: 'none', HW_ENCODING_ENABLED: false },
        envOverrides: [],
        schema: { sections: fixture.sections, settings: fixture.settings },
        configPath: '/config/settings.json',
        storageStatus: { willPersist: true },
    } as unknown as ComponentProps<typeof PlaybackSettings>['data'];
    const { container } = render(PlaybackSettings, { data, form: null });
    expect(updates(container)).toEqual({});
    await fireEvent.click(screen.getByRole('button', { name: 'Detect hardware' }));
    await screen.findByRole('button', { name: 'Apply recommendation' });
    expect(updates(container)).toEqual({});
    await fireEvent.click(screen.getByRole('button', { name: 'Apply recommendation' }));
    await tick();
    expect((container.querySelector('#GPU_ACCELERATION') as HTMLSelectElement).value).toBe('qsv');
    expect(container.querySelector('#HW_ENCODING_ENABLED')?.getAttribute('aria-checked')).toBe(
        'true',
    );
    expect(updates(container)).toEqual({ GPU_ACCELERATION: 'qsv', HW_ENCODING_ENABLED: true });
    expect(screen.getByTestId('hardware-pending')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Save Changes');
    await fireEvent.click(screen.getAllByRole('button', { name: 'Discard' })[0]);
    await tick();
    expect(updates(container)).toEqual({});
    expect((container.querySelector('#GPU_ACCELERATION') as HTMLSelectElement).value).toBe('none');
    expect(screen.queryByTestId('hardware-pending')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Apply recommendation' }));
    await tick();
    expect(updates(container)).toEqual({ GPU_ACCELERATION: 'qsv', HW_ENCODING_ENABLED: true });
});
