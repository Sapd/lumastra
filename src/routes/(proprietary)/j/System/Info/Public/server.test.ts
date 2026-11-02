// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('$lib/server/config', () => ({
    config: { PUBLIC_BASE_URL: 'https://public.example/media/' },
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/serializers/system', () => ({
    getPublicSystemInfo: (base: string) => ({ LocalAddress: base }),
}));
import { config } from '$lib/server/config';
import { GET } from './+server';
afterEach(() => {
    Object.assign(config, { PUBLIC_BASE_URL: 'https://public.example/media/' });
});
it('advertises the public URL rather than the internal proxy origin', async () => {
    const res = await GET({ url: new URL('http://internal:3000/j/System/Info/Public') } as never);
    expect(await res.json()).toMatchObject({ LocalAddress: 'https://public.example/media' });
});
it('falls back to the request origin when no public URL is configured', async () => {
    Object.assign(config, { PUBLIC_BASE_URL: '' });
    const res = await GET({
        url: new URL('https://request.example/j/System/Info/Public'),
    } as never);
    expect(await res.json()).toMatchObject({ LocalAddress: 'https://request.example' });
});
