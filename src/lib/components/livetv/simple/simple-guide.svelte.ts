// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Now/next for the (few) simple-mode channels: one guide request for the next
 * six hours, refreshed every five minutes while the tab is visible, plus a
 * clock that ticks every 30 s.
 */

import { fetchGuidePrograms } from '$lib/api/livetv-playback.js';
import type { LiveTvStation, LiveTvAiring } from '$lib/schemas/livetv.js';
import { nowNext, type NowNext } from './simple-lineup.js';

const WINDOW_MS = 6 * 60 * 60 * 1000;
const REFRESH_MS = 5 * 60 * 1000;

export class SimpleGuide {
    now = $state(Date.now());
    programs = $state<Record<string, LiveTvAiring[]>>({});
    #ids: string[] = [];
    #run = 0;

    /** Start for these channel ids; returns the stop function (use in an $effect). */
    start(stationIds: string[]): () => void {
        this.#ids = stationIds;
        void this.refresh();
        const clock = setInterval(() => {
            this.now = Date.now();
        }, 30_000);
        const refresh = setInterval(() => {
            if (!document.hidden) void this.refresh();
        }, REFRESH_MS);
        const onVisible = (): void => {
            if (!document.hidden) {
                this.now = Date.now();
                void this.refresh();
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            this.#run++;
            clearInterval(clock);
            clearInterval(refresh);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }

    async refresh(): Promise<void> {
        if (this.#ids.length === 0) return;
        const run = ++this.#run;
        const start = Date.now();
        const result = await fetchGuidePrograms(
            // eslint-disable-next-line svelte/prefer-svelte-reactivity -- request bounds, never reactive state
            new Date(start - 60 * 60 * 1000),
            // eslint-disable-next-line svelte/prefer-svelte-reactivity -- request bounds, never reactive state
            new Date(start + WINDOW_MS),
            this.#ids,
        );
        // A failed refresh keeps what is on screen.
        if (run === this.#run && result.data) {
            this.programs = Object.fromEntries(
                result.data.stations.map((station) => [station.stationId, station.airings]),
            );
        }
    }

    for(channel: LiveTvStation): NowNext {
        return nowNext(this.programs[channel.id], this.now, channel.nowNext);
    }
}
