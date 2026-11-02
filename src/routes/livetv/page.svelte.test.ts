// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { load } from './+page';
vi.mock('$lib/components/app-shell', () => ({ GlobalChrome: () => {} }));
const imports = vi.hoisted(() => ({ simple: vi.fn(), grid: vi.fn(), card: vi.fn() }));
vi.mock('$lib/components/livetv/simple/SimpleLiveTvHome.svelte', () => {
    imports.simple();
    return { default: () => {} };
});
vi.mock('$lib/components/livetv/ChannelGrid.svelte', () => {
    imports.grid();
    return { default: () => {} };
});
vi.mock('$lib/components/livetv/ChannelCard.svelte', () => {
    imports.card();
    return { default: () => {} };
});

describe('Live TV interface selection', () => {
    it('loads the selected interface on navigation in either direction', async () => {
        const event = (data: Record<string, unknown>, channels: unknown[] = []) =>
            ({ data, parent: async () => ({ channels }) }) as unknown as Parameters<typeof load>[0];
        const empty = await load(event({ simpleMode: null }));
        expect(empty.channelGrid).toBeNull();
        expect(empty.channelCard).toBeNull();
        expect(imports.grid).not.toHaveBeenCalled();
        expect(imports.card).not.toHaveBeenCalled();
        const simpleMode = { enabled: true };
        const simple = await load(
            event({ simpleMode, personalizedChannels: [], favoriteChannelIds: [] }),
        );
        expect(simple.simpleMode).toBe(simpleMode);
        expect(simple.simpleHome).toBeTypeOf('function');
        expect(simple.channelGrid).toBeNull();
        expect(imports.simple).toHaveBeenCalledOnce();
        expect(imports.grid).not.toHaveBeenCalled();
        expect(imports.card).not.toHaveBeenCalled();

        const regular = await load(
            event({ simpleMode: null, personalizedChannels: [], favoriteChannelIds: ['channel'] }, [
                { id: 'channel' },
            ]),
        );
        expect(regular.simpleHome).toBeNull();
        expect(regular.channelGrid).toBeTypeOf('function');
        expect(regular.channelCard).toBeTypeOf('function');
        expect(regular.favoriteChannelIds).toEqual(['channel']);
        expect(imports.grid).toHaveBeenCalledOnce();
        expect(imports.card).toHaveBeenCalledOnce();

        const back = await load(
            event({ simpleMode, personalizedChannels: [], favoriteChannelIds: [] }),
        );
        expect(back.simpleHome).toBe(simple.simpleHome);
        expect(back.channelGrid).toBeNull();
    });
});
