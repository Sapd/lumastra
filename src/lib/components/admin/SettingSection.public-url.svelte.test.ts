// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it } from 'vitest';
import Section from './SettingSection.svelte';
import { configSections } from '$lib/config/schema';
afterEach(cleanup);
it.each(['trakt', 'mal'])('shows the resolved %s redirect URI for app registration', (provider) => {
    render(Section, {
        section: configSections.find((s) => s.id === `conn-${provider}`)!,
        values: { PUBLIC_BASE_URL: 'https://public.example/media/' },
        envOverrides: new Set<string>(),
        collapsible: false,
    });
    expect(
        screen.getByText(`https://public.example/media/api/integrations/${provider}/callback`),
    ).toBeTruthy();
});
