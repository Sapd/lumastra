<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy, untrack } from 'svelte';
    import { apiGet } from '$lib/api/client';
    import { z } from 'zod';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';
    // Tree-shaken Chart.js imports - only import what we need
    import {
        Chart,
        CategoryScale,
        LinearScale,
        BarElement,
        LineElement,
        PointElement,
        BarController,
        LineController,
        Title,
        Tooltip,
        Legend,
        Filler,
    } from 'chart.js';

    // Register only the components we actually use (including controllers)
    Chart.register(
        CategoryScale,
        LinearScale,
        BarElement,
        LineElement,
        PointElement,
        BarController,
        LineController,
        Title,
        Tooltip,
        Legend,
        Filler,
    );

    // Chart.js canvas colors can't resolve CSS custom properties, so resolve the
    // themed rgb triplet once and build a plain rgba() string for chart series/tooltips.
    function themedRgba(varName: string, fallback: string, alpha: number): string {
        if (typeof document === 'undefined') return `rgba(${fallback}, ${alpha})`;
        const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
        return `rgba(${(raw || fallback).split(/\s+/).join(', ')}, ${alpha})`;
    }

    interface Props {
        data: {
            dayOfWeek: Array<{
                day: string;
                count: number;
                minutes: number;
                percentage: number;
            }>;
            hourOfDay: Array<{
                hour: number;
                count: number;
                minutes: number;
                percentage: number;
            }>;
            totalSessions: number;
            totalMinutes: number;
            avgMinutesPerUser: number;
        };
        // Optional: timeframe for day-hours API call
        timeframe?: string;
        // Callbacks
        ondaySelect?: (day: string | null) => void;
    }

    let { data, timeframe = 'AllTime', ondaySelect }: Props = $props();

    let dayCanvas: HTMLCanvasElement | undefined = $state();
    let hourCanvas: HTMLCanvasElement | undefined = $state();
    let dayChart: Chart | undefined = $state();
    let hourChart: Chart | undefined = $state();

    interface HourData {
        hour: number;
        count: number;
        minutes: number;
        percentage: number;
    }

    // Track selected day and loading state.
    // selectedDay holds the CANONICAL ENGLISH day name used as the API query key.
    // Display labels are always derived via localizedDayLabel().
    let selectedDay = $state<string | null>(null);
    let loadingDayHours = $state(false);

    // Day-specific hour data cache (null when showing overall data)
    let daySpecificHourData = $state<typeof data.hourOfDay | null>(null);

    // Display data - switches between day-specific and overall data
    let displayHourData = $derived(
        selectedDay && daySpecificHourData ? daySpecificHourData : data.hourOfDay,
    );

    const DayHoursResponseSchema = z.object({
        success: z.boolean(),
        stats: z.array(
            z.object({
                hour: z.number(),
                count: z.number(),
                minutes: z.number(),
                percentage: z.number(),
            }),
        ),
        day: z.string().optional(),
    });

    // Canonical English day order used for API keys and data lookup
    const ENGLISH_DAYS = [
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
        'Sunday',
    ];

    /**
     * Returns a locale-aware short weekday name for a canonical English day name.
     * E.g. "Monday" → "Montag" in de, "lundi" in fr.
     * The English name is never sent to the DOM as display text.
     */
    function localizedDayLabel(englishName: string): string {
        // Map English name to a reference date (Mon 2 Jan 2023 = ISO weekday 1)
        const dayIndex = ENGLISH_DAYS.indexOf(englishName);
        if (dayIndex === -1) return englishName;
        // 2023-01-02 is a Monday; add dayIndex to get Mon…Sun
        const date = new Date(2023, 0, 2 + dayIndex);
        try {
            return new Intl.DateTimeFormat(getLocale(), { weekday: 'short' }).format(date);
        } catch {
            return englishName;
        }
    }

    /**
     * Returns a locale-aware hour label (24h zero-padded).
     * E.g. 6 → "06:00", 23 → "23:00"
     */
    function localizedHourLabel(hour: number): string {
        try {
            const date = new Date(2023, 0, 1, hour, 0, 0);
            return new Intl.DateTimeFormat(getLocale(), {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            }).format(date);
        } catch {
            return `${String(hour).padStart(2, '0')}:00`;
        }
    }

    /**
     * Returns a locale-aware percentage string.
     * E.g. 14.3 → "14.3%" in en, "14,3 %" in de
     */
    function localizedPercent(value: number): string {
        try {
            return new Intl.NumberFormat(getLocale(), {
                style: 'percent',
                maximumFractionDigits: 1,
            }).format(value / 100);
        } catch {
            return `${value.toFixed(1)}%`;
        }
    }

    // Fetch day-specific hourly stats
    async function fetchDayHours(day: string) {
        loadingDayHours = true;
        try {
            // Always send the canonical English day name as the API key
            const { data: result, error: fetchError } = await apiGet(
                `/api/watch-stats?type=day-hours&day=${encodeURIComponent(day)}&timeframe=${timeframe}`,
                DayHoursResponseSchema,
            );

            if (fetchError || !result?.stats) {
                console.warn('Failed to fetch day-hours:', fetchError);
                daySpecificHourData = null;
            } else {
                daySpecificHourData = result.stats;
            }
        } catch (error) {
            console.error('Failed to fetch day-specific hours:', error);
            daySpecificHourData = null;
        } finally {
            loadingDayHours = false;
        }
    }

    // Handle day bar click — day is the canonical English name
    function handleDayClick(canonicalDay: string) {
        if (selectedDay === canonicalDay) {
            // Clicking same day again - deselect and show overall
            selectedDay = null;
            daySpecificHourData = null;
            ondaySelect?.(null);
        } else {
            // Select new day (send English name to API)
            selectedDay = canonicalDay;
            fetchDayHours(canonicalDay);
            ondaySelect?.(canonicalDay);
        }
    }

    // Handle keyboard activation on the day chart wrapper
    function handleDayKeydown(event: KeyboardEvent) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (!dayChart || !dayCanvas) return;
        event.preventDefault();

        // Find which bar is currently focused via a synthetic pointer-like approach.
        // We cannot easily determine focus position in Chart.js without a real event,
        // so we use the active elements from the last hover tracked by Chart.js.
        const active = dayChart.getActiveElements();
        if (active.length > 0) {
            const index = active[0].index;
            handleDayClick(ENGLISH_DAYS[index]);
        }
    }

    onMount(() => {
        createDayChart();
        createHourChart();
    });

    onDestroy(() => {
        if (dayChart) dayChart.destroy();
        if (hourChart) hourChart.destroy();
    });

    function buildSortedDays() {
        return ENGLISH_DAYS.map(
            (dayName) =>
                data.dayOfWeek.find((d) => d.day === dayName) || {
                    day: dayName,
                    count: 0,
                    minutes: 0,
                    percentage: 0,
                },
        );
    }

    function createDayChart() {
        if (!dayCanvas || !data.dayOfWeek?.length) return;

        const ctx = dayCanvas.getContext('2d');
        if (!ctx) return;

        const sortedDays = buildSortedDays();
        const tooltipSessions = m.admin_stats_tooltip_sessions();
        const tooltipMinutes = m.admin_stats_tooltip_minutes();
        const tooltipPercentage = m.admin_stats_tooltip_percentage();
        const tooltipClickBreakdown = m.admin_stats_tooltip_click_breakdown();

        dayChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: sortedDays.map((d) => localizedDayLabel(d.day)),
                datasets: [
                    {
                        label: m.sessions(),
                        data: sortedDays.map((d) => d.count),
                        backgroundColor: sortedDays.map((d) =>
                            d.day === selectedDay
                                ? 'rgba(16, 185, 129, 0.9)'
                                : themedRgba('--color-primary-500-rgb', '99 102 241', 0.8),
                        ),
                        borderColor: sortedDays.map((d) =>
                            d.day === selectedDay
                                ? 'rgba(16, 185, 129, 1)'
                                : themedRgba('--color-primary-500-rgb', '99 102 241', 1),
                        ),
                        borderWidth: 1,
                        borderRadius: 8,
                        borderSkipped: false,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                onClick: (_event, elements) => {
                    if (elements.length > 0) {
                        const index = elements[0].index;
                        // Use canonical English name for API, not the localized label
                        handleDayClick(ENGLISH_DAYS[index]);
                    }
                },
                plugins: {
                    legend: {
                        display: false,
                    },
                    tooltip: {
                        backgroundColor: themedRgba('--color-surface-900-rgb', '36 44 70', 0.95),
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderColor: '#374151',
                        borderWidth: 1,
                        callbacks: {
                            label: (context) => {
                                const dayData = sortedDays[context.dataIndex];
                                return [
                                    `${tooltipSessions} ${dayData.count}`,
                                    `${tooltipMinutes} ${dayData.minutes}`,
                                    `${tooltipPercentage} ${localizedPercent(dayData.percentage)}`,
                                    '',
                                    tooltipClickBreakdown,
                                ];
                            },
                        },
                    },
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: '#9CA3AF',
                        },
                        grid: {
                            color: 'rgba(156, 163, 175, 0.1)',
                        },
                    },
                    x: {
                        ticks: {
                            color: '#9CA3AF',
                        },
                        grid: {
                            display: false,
                        },
                    },
                },
            },
        });
    }

    function buildSortedHours(hourData: typeof data.hourOfDay) {
        // Sort hours starting from 6 AM: 6,7,8...23,0,1,2,3,4,5
        const hourOrder = [
            6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5,
        ];
        return hourOrder.map(
            (hourNum) =>
                hourData.find((h) => h.hour === hourNum) || {
                    hour: hourNum,
                    count: 0,
                    minutes: 0,
                    percentage: 0,
                },
        );
    }

    function createHourChart() {
        if (!hourCanvas || !data.hourOfDay?.length) return;

        const ctx = hourCanvas.getContext('2d');
        if (!ctx) return;

        const sortedHours = buildSortedHours(displayHourData);
        const tooltipSessions = m.admin_stats_tooltip_sessions();
        const tooltipMinutes = m.admin_stats_tooltip_minutes();
        const tooltipTime = m.admin_stats_tooltip_time();

        hourChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: sortedHours.map((h) => localizedHourLabel(h.hour)),
                datasets: [
                    {
                        label: m.sessions(),
                        data: sortedHours.map((h) => h.count),
                        borderColor: 'rgba(16, 185, 129, 1)',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        borderWidth: 3,
                        fill: true,
                        tension: 0.4,
                        pointBackgroundColor: 'rgba(16, 185, 129, 1)',
                        pointBorderColor: '#fff',
                        pointBorderWidth: 2,
                        pointRadius: 5,
                        pointHoverRadius: 8,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false,
                    },
                    tooltip: {
                        backgroundColor: themedRgba('--color-surface-900-rgb', '36 44 70', 0.95),
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderColor: '#374151',
                        borderWidth: 1,
                        callbacks: {
                            label: (context) => {
                                const hourData = sortedHours[context.dataIndex];
                                return [
                                    `${tooltipTime} ${localizedHourLabel(hourData.hour)}`,
                                    `${tooltipSessions} ${hourData.count}`,
                                    `${tooltipMinutes} ${hourData.minutes || 0}`,
                                ];
                            },
                        },
                    },
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: '#9CA3AF',
                        },
                        grid: {
                            color: 'rgba(156, 163, 175, 0.1)',
                        },
                    },
                    x: {
                        ticks: {
                            color: '#9CA3AF',
                            maxTicksLimit: 12,
                        },
                        grid: {
                            color: 'rgba(156, 163, 175, 0.1)',
                        },
                    },
                },
            },
        });
    }

    // Reactive updates for day chart (including selection highlighting and locale changes).
    // Rebuild the chart when data or locale changes to pick up translated strings.
    $effect(() => {
        // Triggers: locale (rebuild on language switch) + the day dataset.
        // The chart INSTANCE (dayChart) is read AND written here — reading it as a
        // tracked dependency while reassigning it would re-invalidate this effect on
        // every run and loop (effect_update_depth_exceeded). So the instance
        // lifecycle runs inside untrack(); only _locale/dayCanvas/dayData drive re-runs.
        const _locale = getLocale();
        const dayData = data?.dayOfWeek;
        const hasData = !!(dayCanvas && dayData?.length);
        untrack(() => {
            if (hasData) {
                if (dayChart) {
                    dayChart.destroy();
                    dayChart = undefined;
                }
                createDayChart();
            } else if (dayChart) {
                dayChart.destroy();
                dayChart = undefined;
            }
        });
    });

    // Update day chart colors when selection changes (without full rebuild)
    $effect(() => {
        if (dayChart && selectedDay !== undefined) {
            dayChart.data.datasets[0].backgroundColor = ENGLISH_DAYS.map((d) =>
                d === selectedDay
                    ? 'rgba(16, 185, 129, 0.9)'
                    : themedRgba('--color-primary-500-rgb', '99 102 241', 0.8),
            );
            dayChart.data.datasets[0].borderColor = ENGLISH_DAYS.map((d) =>
                d === selectedDay
                    ? 'rgba(16, 185, 129, 1)'
                    : themedRgba('--color-primary-500-rgb', '99 102 241', 1),
            );
            dayChart.update();
        }
    });

    // Reactive updates for hour chart — rebuild on locale or data changes
    $effect(() => {
        // Same self-invalidation guard as the day chart. Track locale + the resolved
        // hour dataset (displayHourData swaps in day-specific data on drilldown, so we
        // track the reference, not just .length) and mutate the hourChart instance
        // untracked.
        const _locale = getLocale();
        const hourData = displayHourData;
        const overallHourData = data.hourOfDay;
        const hasData = !!(hourCanvas && (hourData?.length || overallHourData?.length));
        untrack(() => {
            if (hasData) {
                if (hourChart) {
                    hourChart.destroy();
                    hourChart = undefined;
                }
                createHourChart();
            } else if (hourChart) {
                hourChart.destroy();
                hourChart = undefined;
            }
        });
    });

    // Derived aria labels for both canvases
    let dayChartAriaLabel = $derived(
        data.dayOfWeek?.length ? m.admin_stats_activity_by_day() : m.admin_stats_no_activity_data(),
    );

    let hourChartAriaLabel = $derived(
        selectedDay
            ? m.admin_stats_activity_by_hour_on_day({ day: localizedDayLabel(selectedDay) })
            : m.admin_stats_activity_by_hour(),
    );

    // Visually-hidden summary text for screen readers (day chart)
    let dayChartSummary = $derived(
        data.dayOfWeek?.length
            ? data.dayOfWeek
                  .slice()
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 3)
                  .map(
                      (d) =>
                          `${localizedDayLabel(d.day)}: ${d.count} ${m.sessions()}, ${localizedPercent(d.percentage)}`,
                  )
                  .join('; ')
            : '',
    );
</script>

<div class="space-y-8">
    <!-- Summary Stats -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="bg-gray-700/50 rounded-lg p-4 text-center border border-gray-600/50">
            <div class="text-3xl font-bold text-blue-400 mb-1">
                {data.totalSessions}
            </div>
            <div class="text-label">
                <span aria-hidden="true">📺</span>
                {m.admin_stats_total_sessions()}
            </div>
        </div>
        <div class="bg-gray-700/50 rounded-lg p-4 text-center border border-gray-600/50">
            <div class="text-3xl font-bold text-green-400 mb-1">
                {Math.round(data.totalMinutes / 60)}h
            </div>
            <div class="text-label">
                <span aria-hidden="true">⏰</span>
                {m.admin_stats_total_hours()}
            </div>
        </div>
        <div class="bg-gray-700/50 rounded-lg p-4 text-center border border-gray-600/50">
            <div class="text-3xl font-bold text-yellow-400 mb-1">
                {Math.round(data.avgMinutesPerUser * 10) / 10}m
            </div>
            <div class="text-label">
                <span aria-hidden="true">👤</span>
                {m.admin_stats_avg_per_user()}
            </div>
        </div>
    </div>

    <!-- Charts -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <!-- Day of Week Chart -->
        <div class="bg-gray-700/30 rounded-lg p-6">
            <h4 class="text-lg font-semibold text-white mb-4">{m.admin_stats_activity_by_day()}</h4>
            {#if data.dayOfWeek?.length}
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <div
                    class="relative h-64 cursor-pointer"
                    role="img"
                    aria-label={dayChartAriaLabel}
                    tabindex="0"
                    onkeydown={handleDayKeydown}>
                    <canvas bind:this={dayCanvas} aria-hidden="true"></canvas>
                    {#if dayChartSummary}
                        <span class="sr-only">{dayChartSummary}</span>
                    {/if}
                </div>
            {:else}
                <div class="relative h-64 center">
                    <p class="text-gray-400 text-center">{m.admin_stats_no_activity_data()}</p>
                </div>
            {/if}
        </div>

        <!-- Hour of Day Chart -->
        <div class="bg-gray-700/30 rounded-lg p-6">
            <div class="between mb-4">
                <h4 class="text-lg font-semibold text-white">
                    {#if selectedDay}
                        {m.admin_stats_activity_by_hour_on_day({
                            day: localizedDayLabel(selectedDay),
                        })}
                    {:else}
                        {m.admin_stats_activity_by_hour()}
                    {/if}
                </h4>
                {#if selectedDay}
                    <button
                        onclick={() => handleDayClick(selectedDay || '')}
                        class="text-muted hover:text-white transition-colors">
                        ✕ {m.admin_stats_clear_selection()}
                    </button>
                {/if}
            </div>
            {#if data.hourOfDay?.length}
                <div class="relative h-64" role="img" aria-label={hourChartAriaLabel}>
                    {#if loadingDayHours}
                        <div
                            class="absolute inset-0 center bg-gray-800/80 rounded-lg z-10"
                            role="status"
                            aria-live="polite">
                            <div class="text-gray-400">{m.loading_default()}</div>
                        </div>
                    {/if}
                    <canvas bind:this={hourCanvas} aria-hidden="true"></canvas>
                </div>
            {:else}
                <div class="relative h-64 center">
                    <p class="text-gray-400 text-center">{m.admin_stats_no_activity_data()}</p>
                </div>
            {/if}
            {#if !selectedDay}
                <p class="text-caption mt-2 text-center">
                    {m.admin_stats_hint_click_day()}
                </p>
            {/if}
        </div>
    </div>
</div>
