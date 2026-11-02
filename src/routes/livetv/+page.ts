// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageLoad, PageServerData } from './$types';
import type SimpleLiveTvHome from '$lib/components/livetv/simple/SimpleLiveTvHome.svelte';
import type ChannelGrid from '$lib/components/livetv/ChannelGrid.svelte';
import type ChannelCard from '$lib/components/livetv/ChannelCard.svelte';

type ViewData = PageServerData & {
    simpleHome: typeof SimpleLiveTvHome | null;
    channelGrid: typeof ChannelGrid | null;
    channelCard: typeof ChannelCard | null;
};

/** Keep SSR/hydration identical while loading only the selected interface. */
export const load = async ({ data, parent }: Parameters<PageLoad>[0]): Promise<ViewData> => {
    if (data.simpleMode)
        return {
            ...data,
            simpleHome: (await import('$lib/components/livetv/simple/SimpleLiveTvHome.svelte'))
                .default,
            channelGrid: null,
            channelCard: null,
        };
    if ((await parent()).channels.length === 0)
        return { ...data, simpleHome: null, channelGrid: null, channelCard: null };
    const [grid, card] = await Promise.all([
        import('$lib/components/livetv/ChannelGrid.svelte'),
        import('$lib/components/livetv/ChannelCard.svelte'),
    ]);
    return {
        ...data,
        simpleHome: null,
        channelGrid: grid.default,
        channelCard: card.default,
    };
};
