// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it, vi } from 'vitest';
const shells = vi.hoisted(() => ({
    education: vi.fn(),
    personal: vi.fn(),
    Educational: () => undefined,
    Personal: () => undefined,
}));
vi.mock('$lib/components/viewing/EducationalShell.svelte', () => {
    shells.education();
    return { default: shells.Educational };
});
vi.mock('$lib/components/viewing/PersonalShell.svelte', () => {
    shells.personal();
    return { default: shells.Personal };
});

it('loads only the viewing shell selected by server data and preserves all server fields', async () => {
    const { load } = await import('./+page');
    const parent = vi.fn(() => {
        throw new Error('Cached parent data must not decide shell availability');
    });
    const run = (kind: string, available = true) =>
        load({
            parent,
            data: {
                viewingContext: { kind },
                viewingShellAvailable: available,
                pageTitle: 'Fixture',
                playbackInfo: { itemId: 'fixture' },
            },
        } as unknown as Parameters<typeof load>[0]);
    const movie = await run('vod');
    expect(movie.educationalShell).toBeNull();
    expect(movie.personalShell).toBeNull();
    expect(shells.education).not.toHaveBeenCalled();
    expect(shells.personal).not.toHaveBeenCalled();
    expect(parent).not.toHaveBeenCalled();
    for (const kind of ['educational', 'personal']) {
        const result = await run(kind, false);
        expect(result.educationalShell).toBeNull();
        expect(result.personalShell).toBeNull();
    }
    expect(shells.education).not.toHaveBeenCalled();
    expect(shells.personal).not.toHaveBeenCalled();
    const educational = await run('educational');
    expect(educational.educationalShell).toBe(shells.Educational);
    expect(educational.personalShell).toBeNull();
    expect(shells.personal).not.toHaveBeenCalled();
    expect(educational).toMatchObject({
        pageTitle: 'Fixture',
        playbackInfo: { itemId: 'fixture' },
    });
    const personal = await run('personal');
    expect(personal.personalShell).toBe(shells.Personal);
    expect(personal.educationalShell).toBeNull();
    expect(parent).not.toHaveBeenCalled();
});
