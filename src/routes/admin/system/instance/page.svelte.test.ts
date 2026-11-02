// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render, within } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return { page: readable({ url: new URL('http://localhost/admin/system/instance'), data: {} }) };
});
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));
import Page from './+page.svelte';
afterEach(cleanup);

it('formats bundled notices and escapes embedded HTML', () => {
    const view = render(Page, {
        data: {
            selected: [],
            landingPath: '/browse',
            presets: [],
            profileUpdates: [],
            capabilities: {},
            buildInfo: {},
            metadataAttributionProviders: [],
            thirdPartyNotices:
                '# Fictional notices\n\nUses `example-codec` and [Example project](https://example.org/).\n<img src=x onerror="alert(1)">',
        } as never,
        form: null,
    });
    const notices = view.container.querySelector('#licenses')! as HTMLElement;
    expect(notices.querySelector('strong')?.textContent).toBe('Fictional notices');
    expect(
        within(notices)
            .getByRole('link', { name: 'Example project', hidden: true })
            .getAttribute('href'),
    ).toBe('https://example.org/');
    expect(notices.querySelector('code')?.textContent).toBe('third-party-npm-licenses.json');
    expect(
        [...notices.querySelectorAll('code')].some((node) => node.textContent === 'example-codec'),
    ).toBe(true);
    expect(notices.querySelector('img')).toBeNull();
});
