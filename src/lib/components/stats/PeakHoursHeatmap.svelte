<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteMap } from 'svelte/reactivity';
    import type { PeakHoursStats } from '$lib/types/personal-stats';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';

    interface Props {
        data: PeakHoursStats;
    }

    let { data }: Props = $props();

    // Localized day names (short) — index matches server dayOfWeek (0=Sun)
    let days = $derived([
        m.stats_day_sun(),
        m.stats_day_mon(),
        m.stats_day_tue(),
        m.stats_day_wed(),
        m.stats_day_thu(),
        m.stats_day_fri(),
        m.stats_day_sat(),
    ]);

    // Full day names for aria-labels
    let fullDays = $derived([
        m.stats_day_full_sun(),
        m.stats_day_full_mon(),
        m.stats_day_full_tue(),
        m.stats_day_full_wed(),
        m.stats_day_full_thu(),
        m.stats_day_full_fri(),
        m.stats_day_full_sat(),
    ]);

    // Map English day name (from server) to numeric index for localization
    const englishDayToIndex: Record<string, number> = {
        Sunday: 0,
        Monday: 1,
        Tuesday: 2,
        Wednesday: 3,
        Thursday: 4,
        Friday: 5,
        Saturday: 6,
    };

    /** Localized peak day name derived from the English server value */
    let localizedPeakDay = $derived(days[englishDayToIndex[data.peakDay] ?? 0] ?? data.peakDay);

    const hours = Array.from({ length: 24 }, (_, i) => i);

    // Build a lookup map for quick access
    let cellMap = $derived(
        new SvelteMap(data.cells.map((cell) => [`${cell.dayOfWeek}-${cell.hour}`, cell])),
    );

    function getCellIntensity(day: number, hour: number): number {
        const cell = cellMap.get(`${day}-${hour}`);
        return cell?.intensity || 0;
    }

    function getCellColor(intensity: number): string {
        if (intensity === 0) return 'bg-gray-800';
        if (intensity < 0.2) return 'bg-blue-900/40';
        if (intensity < 0.4) return 'bg-blue-800/60';
        if (intensity < 0.6) return 'bg-blue-700/70';
        if (intensity < 0.8) return 'bg-blue-600/80';
        return 'bg-blue-500';
    }

    function getCellSessionCount(day: number, hour: number): number {
        return cellMap.get(`${day}-${hour}`)?.sessionCount ?? 0;
    }

    function getCellTooltip(day: number, hour: number): string {
        const cell = cellMap.get(`${day}-${hour}`);
        if (!cell || cell.sessionCount === 0) {
            return `${fullDays[day]} ${formatHour(hour)} - ${m.stats_peak_hours_no_sessions()}`;
        }
        const hrs = Math.floor(cell.totalSeconds / 3600);
        const mins = Math.floor((cell.totalSeconds % 3600) / 60);
        const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        return `${fullDays[day]} ${formatHour(hour)} - ${m.stats_peak_hours_sessions({ count: cell.sessionCount, time: timeStr })}`;
    }

    /** Format hour as locale-aware string (24h for de, 12h for en) */
    function formatHour(hour: number): string {
        const locale = getLocale();
        return new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: undefined }).format(
            new Date(2000, 0, 1, hour, 0, 0),
        );
    }

    /** Intensity thresholds and legend ranges */
    const legendBands = [
        { color: 'bg-gray-800', label: '0%' },
        { color: 'bg-blue-900/40', label: '1–19%' },
        { color: 'bg-blue-800/60', label: '20–39%' },
        { color: 'bg-blue-700/70', label: '40–59%' },
        { color: 'bg-blue-600/80', label: '60–79%' },
        { color: 'bg-blue-500', label: '80–100%' },
    ] as const;
</script>

<div class="bg-gray-800/50 rounded-xl p-6 border border-gray-700/50">
    <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-6">
        <div>
            <h3 class="text-lg font-bold text-white">
                {m.stats_peak_hours_title()}
            </h3>
            <p class="text-muted">
                {m.stats_peak_hours_peak_time_fmt({
                    day: localizedPeakDay,
                    hour: formatHour(data.peakHour),
                })}
            </p>
        </div>
        <div class="flex gap-4 text-sm flex-shrink-0">
            <div class="flex items-center gap-2">
                <span class="text-gray-400">{m.stats_peak_hours_night_owl()}</span>
                <span class="font-bold text-purple-400">{data.nightOwlScore}%</span>
            </div>
            <div class="flex items-center gap-2">
                <span class="text-gray-400">{m.stats_peak_hours_weekend()}</span>
                <span class="font-bold text-cyan-400">{data.weekendWarriorScore}%</span>
            </div>
        </div>
    </div>

    <!-- Heatmap Grid -->
    <div class="overflow-x-auto">
        <div class="min-w-[600px]">
            <!-- Hour labels row -->
            <div class="flex mb-1" role="presentation">
                <!-- Spacer matching sticky day-label column -->
                <div class="w-12 flex-shrink-0"></div>
                {#each hours as hour (hour)}
                    {#if hour % 3 === 0}
                        <div class="flex-1 text-center text-xs text-gray-400">
                            {formatHour(hour)}
                        </div>
                    {:else}
                        <div class="flex-1"></div>
                    {/if}
                {/each}
            </div>

            <!-- Accessible heatmap grid -->
            <div role="img" aria-label={m.stats_peak_hours_grid_label()}>
                <!-- Hidden table summary for screen readers -->
                <!-- sr-only on a wrapping div, NOT on the <table>: a table ignores width:1px
                     (it keeps its min-content width), and as position:absolute with no positioned
                     ancestor it escapes every overflow clip — on phones it widened the layout
                     viewport to ~1100px, stretching all position:fixed layers with it. -->
                <div class="sr-only">
                    <table>
                        <caption>{m.stats_peak_hours_grid_label()}</caption>
                        <thead>
                            <tr>
                                <th scope="col">{m.stats_peak_hours_axis_day()}</th>
                                {#each hours as hour (hour)}
                                    <th scope="col">{formatHour(hour)}</th>
                                {/each}
                            </tr>
                        </thead>
                        <tbody>
                            {#each Array.from({ length: 7 }, (_, i) => i) as dayIndex (dayIndex)}
                                <tr>
                                    <th scope="row">{fullDays[dayIndex]}</th>
                                    {#each hours as hour (hour)}
                                        <td>{getCellSessionCount(dayIndex, hour)}</td>
                                    {/each}
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>

                <!-- Visual grid rows (aria-hidden since the table above covers SR) -->
                <div aria-hidden="true">
                    {#each Array.from({ length: 7 }, (_, i) => i) as dayIndex (dayIndex)}
                        <div class="flex items-center gap-1 mb-1">
                            <!-- Sticky day label so it stays visible when scrolling horizontally -->
                            <div
                                class="w-12 flex-shrink-0 text-right pr-2 text-xs text-gray-400 sticky left-0 bg-gray-800/90 z-10">
                                {days[dayIndex]}
                            </div>
                            {#each hours as hour (hour)}
                                {@const intensity = getCellIntensity(dayIndex, hour)}
                                <div
                                    class="flex-1 aspect-square rounded-sm {getCellColor(
                                        intensity,
                                    )} transition-colors hover:ring-2 hover:ring-white/30"
                                    title={getCellTooltip(dayIndex, hour)}>
                                </div>
                            {/each}
                        </div>
                    {/each}
                </div>
            </div>

            <!-- Legend -->
            <div class="flex items-center justify-end gap-2 mt-4" role="presentation">
                <span class="text-xs text-gray-400">{m.stats_peak_hours_less()}</span>
                <div
                    class="flex gap-1 items-end"
                    role="list"
                    aria-label={m.stats_peak_hours_legend_label()}>
                    {#each legendBands as band (band.label)}
                        <div
                            role="listitem"
                            class="flex flex-col items-center gap-0.5"
                            title={band.label}>
                            <span class="text-[10px] text-gray-400 leading-none">{band.label}</span>
                            <div class="w-4 h-4 rounded-sm {band.color}"></div>
                        </div>
                    {/each}
                </div>
                <span class="text-xs text-gray-400">{m.stats_peak_hours_more()}</span>
            </div>
        </div>
    </div>
</div>
