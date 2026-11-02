// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import type { SettingDefinition } from '$lib/config/schema';
import SettingSection from '../SettingSection.svelte';

vi.mock('$lib/paths', () => ({
    resolve: (path: string): string => path,
    url: (path: string): string => path,
}));
vi.mock('$lib/paraglide/messages.js', async () => {
    const { default: messages } = await import('../../../../../messages/en.json');
    return Object.fromEntries(
        Object.entries(messages).map(([key, value]) => [
            key,
            (args: Record<string, unknown> = {}): string =>
                String(value).replace(/\{(\w+)\}/g, (_, name: string) =>
                    String(args[name] ?? `{${name}}`),
                ),
        ]),
    );
});
vi.mock('$lib/api/admin', () => ({ checkProviderHealth: vi.fn() }));
afterEach(cleanup);

const section = {
    id: 'fixture',
    label: 'Fixture controls',
    description: 'Test controls',
    order: 1,
};
function setting(key: string, extra: Partial<SettingDefinition> = {}): SettingDefinition {
    return {
        key,
        type: 'string',
        label: key,
        description: 'Test setting',
        defaultValue: '',
        section: section.id,
        ...extra,
    };
}

it.each([{ equals: 'qsv' }, { notEquals: 'none' }])(
    'reveals a showWhen-inactive search result read-only with its prerequisite (%o)',
    (condition) => {
        render(SettingSection, {
            section,
            settingsOverride: [
                setting('CHILD', { showWhen: { key: 'GPU_ACCELERATION', ...condition } }),
            ],
            values: { GPU_ACCELERATION: 'none', CHILD: 'saved' },
            envOverrides: new Set<string>(),
            searchQuery: 'child',
            collapsible: false,
        });
        expect((screen.getByRole('textbox', { name: /^CHILD/ }) as HTMLInputElement).disabled).toBe(
            true,
        );
        expect(screen.getByText(/Inactive:/)).toBeTruthy();
        expect(
            screen.getByRole('link', { name: 'Open prerequisite' }).getAttribute('href'),
        ).toContain('highlight=GPU_ACCELERATION');
    },
);

it('keeps normal browsing hidden while an exact target reveals the locked row', () => {
    const props = {
        section,
        settingsOverride: [
            setting('CHILD', { showWhen: { key: 'GPU_ACCELERATION', equals: 'qsv' } }),
        ],
        values: { GPU_ACCELERATION: 'none' },
        envOverrides: new Set<string>(),
        collapsible: false,
    };
    const first = render(SettingSection, props);
    expect(screen.queryByLabelText('CHILD')).toBeNull();
    first.unmount();
    render(SettingSection, { ...props, targetSettingKey: 'CHILD' });
    expect((screen.getByRole('textbox', { name: /^CHILD/ }) as HTMLInputElement).disabled).toBe(
        true,
    );
});

it('shows both environment precedence and dependency reason without a broken controller link', () => {
    render(SettingSection, {
        section,
        settingsOverride: [setting('CHILD', { dependsOn: 'UNMAPPED_SWITCH' })],
        values: { UNMAPPED_SWITCH: false },
        envOverrides: new Set(['CHILD']),
        collapsible: false,
    });
    expect((screen.getByRole('textbox', { name: /^CHILD/ }) as HTMLInputElement).disabled).toBe(
        true,
    );
    expect(screen.getByText('Inactive until UNMAPPED_SWITCH is enabled.')).toBeTruthy();
    expect(screen.getByText(/CHILD overrides settings.json/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open prerequisite' })).toBeNull();
});

it('locks a matching descendant when a string-valued ancestor is inactive', () => {
    render(SettingSection, {
        section,
        settingsOverride: [
            setting('PARENT', { showWhen: { key: 'GPU_ACCELERATION', equals: 'qsv' } }),
            setting('CHILD', { dependsOn: 'PARENT' }),
        ],
        values: { GPU_ACCELERATION: 'none', PARENT: true, CHILD: 'saved' },
        envOverrides: new Set<string>(),
        searchQuery: 'child',
        collapsible: false,
    });
    expect((screen.getByRole('textbox', { name: /^CHILD/ }) as HTMLInputElement).disabled).toBe(
        true,
    );
    expect(screen.getAllByText(/Inactive: GPU Acceleration/).length).toBeGreaterThan(0);
});
