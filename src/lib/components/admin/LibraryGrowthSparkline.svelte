<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { Icon, ExclamationTriangle } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { getLocale } from '$lib/paraglide/runtime';
    import { getLibraryStorageGrowth } from '$lib/api/admin.js';
    import { formatBytes } from '$lib/utils/admin/formatters';
    import { buildStorageForecast } from '$lib/utils/admin/storage-forecast';
    import type {
        LibraryGrowthPoint,
        LibraryStorageGrowth,
    } from '$lib/schemas/admin-library-storage-growth';

    /**
     * Decorative library-size trend for the admin home Library tile, plus the
     * "≈ N months until full" line. It fetches its own data once; it renders
     * NOTHING while loading, on error, or with fewer than two points, so the
     * card looks exactly as it did before when there is nothing to draw. It
     * never feeds the verdict.
     *
     * Colours come from theme tokens only (`--color-primary-*`, `--color-surface-*`).
     * Geometry: the paths live in a stretched viewBox (preserveAspectRatio none,
     * non-scaling strokes); the dots and crosshair are HTML elements placed by
     * percentage, so they stay round at any width.
     */

    const W = 300;
    const H = 56;
    const PAD_Y = 6;

    const uid = $props.id();

    let data = $state<LibraryStorageGrowth | null>(null);
    let active = $state<number | null>(null);
    let box = $state<HTMLDivElement | null>(null);

    onMount(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await getLibraryStorageGrowth();
                if (!cancelled && res.data) data = res.data;
            } catch {
                // Decorative: stay hidden.
            }
        })();
        return () => {
            cancelled = true;
        };
    });

    const series = $derived<LibraryGrowthPoint[]>(data?.series ?? []);
    const ready = $derived(series.length >= 2);

    function dayMs(date: string): number {
        return Date.parse(`${date}T00:00:00Z`);
    }

    interface Plot {
        fx: number; // 0..1 across the width
        x: number; // viewBox x
        y: number; // viewBox y (== px, the box is H px tall)
        approximate: boolean;
    }

    const plot = $derived.by((): Plot[] => {
        const pts = series;
        if (pts.length < 2) return [];
        const t0 = dayMs(pts[0].date);
        const span = dayMs(pts[pts.length - 1].date) - t0;
        let min = Infinity;
        let max = -Infinity;
        for (const p of pts) {
            if (p.bytes < min) min = p.bytes;
            if (p.bytes > max) max = p.bytes;
        }
        const spread = max - min;
        // A trend glyph, not a magnitude bar: no zero baseline, a little headroom.
        const pad = spread === 0 ? 1 : spread * 0.12;
        const lo = min - pad;
        const hi = max + pad;
        const top = PAD_Y;
        const bottom = H - PAD_Y;
        return pts.map((p, i) => {
            const fx = span > 0 ? (dayMs(p.date) - t0) / span : i / (pts.length - 1);
            const y = bottom - ((p.bytes - lo) / (hi - lo)) * (bottom - top);
            return { fx, x: fx * W, y, approximate: p.approximate };
        });
    });

    interface Group {
        approximate: boolean;
        line: string;
    }

    /** Runs of the same kind; a segment touching an approximate point is approximate. */
    const groups = $derived.by((): Group[] => {
        const pts = plot;
        const out: Group[] = [];
        let cur: Plot[] = [];
        let kind: boolean | null = null;
        const flush = () => {
            if (cur.length < 2 || kind === null) return;
            const line = cur
                .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
                .join(' ');
            out.push({ approximate: kind, line });
        };
        for (let i = 1; i < pts.length; i++) {
            const approx = pts[i].approximate || pts[i - 1].approximate;
            if (approx !== kind) {
                flush();
                cur = [pts[i - 1]];
                kind = approx;
            }
            cur.push(pts[i]);
        }
        flush();
        return out;
    });

    /**
     * ONE area under the whole curve. Per-run areas left the measured tail (a
     * few weeks at the right edge of a two-year axis) as a bright column.
     */
    const area = $derived.by((): string => {
        const pts = plot;
        if (pts.length < 2) return '';
        const line = pts
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
            .join(' ');
        return `${line} L${pts[pts.length - 1].x.toFixed(2)} ${H} L${pts[0].x.toFixed(2)} ${H} Z`;
    });

    const forecast = $derived(data ? buildStorageForecast(data.volumes) : null);

    function formatDate(date: string): string {
        try {
            return new Intl.DateTimeFormat(getLocale(), {
                dateStyle: 'medium',
                timeZone: 'UTC',
            }).format(new Date(dayMs(date)));
        } catch {
            return date;
        }
    }

    const summary = $derived.by((): string => {
        if (!ready) return '';
        const first = series[0];
        const last = series[series.length - 1];
        const params = {
            from: formatBytes(first.bytes),
            fromDate: formatDate(first.date),
            to: formatBytes(last.bytes),
            toDate: formatDate(last.date),
        };
        if (last.bytes > first.bytes) return m.admin_home_growth_aria_grew(params);
        if (last.bytes < first.bytes) return m.admin_home_growth_aria_shrank(params);
        return m.admin_home_growth_aria_flat(params);
    });

    const current = $derived(active !== null ? (series[active] ?? null) : null);
    const readout = $derived.by((): string => {
        if (!current) return '';
        const args = { size: formatBytes(current.bytes), date: formatDate(current.date) };
        return current.approximate
            ? m.admin_home_growth_readout_approx(args)
            : m.admin_home_growth_readout(args);
    });

    const lastIndex = $derived(series.length - 1);

    function nearest(clientX: number): number {
        if (!box || plot.length === 0) return lastIndex;
        const rect = box.getBoundingClientRect();
        if (rect.width <= 0) return lastIndex;
        const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < plot.length; i++) {
            const d = Math.abs(plot[i].fx - f);
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        return best;
    }

    function onPointer(event: PointerEvent): void {
        active = nearest(event.clientX);
    }

    function onPointerLeave(event: PointerEvent): void {
        // Touch keeps the readout after the finger lifts; a tap elsewhere clears it.
        if (event.pointerType === 'mouse') active = null;
    }

    function onWindowPointerDown(event: PointerEvent): void {
        if (active !== null && box && !box.contains(event.target as Node)) active = null;
    }

    function onKeydown(event: KeyboardEvent): void {
        const base = active ?? lastIndex;
        let next: number;
        switch (event.key) {
            case 'ArrowLeft':
                next = Math.max(0, base - 1);
                break;
            case 'ArrowRight':
                next = Math.min(lastIndex, active === null ? lastIndex : base + 1);
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = lastIndex;
                break;
            case 'Escape':
                if (active !== null) {
                    event.preventDefault();
                    active = null;
                }
                return;
            default:
                return;
        }
        event.preventDefault();
        active = next;
    }

    const toneClass = {
        neutral: 'text-surface-400',
        warning: 'text-amber-400',
        critical: 'text-red-400',
    } as const;

    const tipPlacement = $derived.by((): string => {
        if (active === null || !plot[active]) return '';
        const f = plot[active].fx;
        if (f < 0.2) return 'left: 0;';
        if (f > 0.8) return 'right: 0;';
        return `left: ${(f * 100).toFixed(2)}%; transform: translateX(-50%);`;
    });
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<!-- The forecast does not need the curve: a disk can be filling while the
     library has too few sized files to draw one. -->
{#if ready || forecast}
    <div class="mt-3" data-testid="library-growth">
        {#if ready}
            <div
                bind:this={box}
                class="growth-box relative h-14 w-full touch-pan-y rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400"
                style="color: var(--color-primary-400);"
                role="slider"
                tabindex="0"
                aria-label={summary}
                aria-describedby="{uid}-hint"
                aria-valuemin={0}
                aria-valuemax={lastIndex}
                aria-valuenow={active ?? lastIndex}
                aria-valuetext={readout || summary}
                onpointerdown={onPointer}
                onpointermove={onPointer}
                onpointerleave={onPointerLeave}
                onkeydown={onKeydown}>
                <svg
                    class="growth-reveal absolute inset-0 h-full w-full overflow-visible"
                    viewBox="0 0 {W} {H}"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                    focusable="false">
                    <defs>
                        <linearGradient id="{uid}-area" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0" stop-color="currentColor" stop-opacity="0.3" />
                            <stop offset="1" stop-color="currentColor" stop-opacity="0" />
                        </linearGradient>
                    </defs>
                    <path d={area} fill="url(#{uid}-area)" stroke="none" />
                    {#each groups as g, i (i)}
                        <path
                            d={g.line}
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-opacity={g.approximate ? 0.7 : 1}
                            stroke-dasharray={g.approximate ? '2 4' : undefined}
                            class={g.approximate ? undefined : 'growth-glow'}
                            vector-effect="non-scaling-stroke"
                            data-testid={g.approximate
                                ? 'growth-line-approx'
                                : 'growth-line-solid'} />
                    {/each}
                </svg>

                {#if current && active !== null && plot[active]}
                    <div
                        class="pointer-events-none absolute inset-y-0 w-px bg-surface-500"
                        style="left: {plot[active].fx * 100}%;"
                        data-testid="growth-crosshair">
                    </div>
                    <div
                        class="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                        style="left: {plot[active].fx * 100}%; top: {plot[active]
                            .y}px; background: var(--color-primary-400); border-color: var(--color-surface-800);">
                    </div>
                    <div
                        class="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md border border-surface-600 bg-surface-900 px-2 py-1 text-xs shadow-lg"
                        style={tipPlacement}
                        aria-hidden="true"
                        data-testid="growth-tooltip">
                        <div class="font-semibold text-white">{formatBytes(current.bytes)}</div>
                        <div class="text-surface-300">{formatDate(current.date)}</div>
                        {#if current.approximate}
                            <div class="text-surface-400">{m.admin_home_growth_approx_note()}</div>
                        {/if}
                    </div>
                {/if}

                <!-- Latest point: always marked. -->
                <div
                    class="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                    style="left: {plot[lastIndex].fx * 100}%; top: {plot[lastIndex]
                        .y}px; background: var(--color-primary-400); border-color: var(--color-surface-800); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-primary-400) 22%, transparent);"
                    data-testid="growth-latest-dot">
                </div>
            </div>

            <p id="{uid}-hint" class="sr-only">{m.admin_home_growth_hint()}</p>
            <div class="sr-only" aria-live="polite" data-testid="growth-readout">{readout}</div>
        {/if}

        {#if forecast}
            <p
                class="mt-1.5 flex items-center gap-1.5 text-xs leading-snug {toneClass[
                    forecast.tone
                ]}"
                title={forecast.title}
                data-testid="growth-forecast"
                data-tone={forecast.tone}>
                {#if forecast.tone !== 'neutral'}
                    <Icon src={ExclamationTriangle} class="h-3.5 w-3.5 shrink-0" />
                {/if}
                <span>{forecast.text}</span>
            </p>
            {#if forecast.precision}
                <p
                    class="mt-0.5 text-xs leading-snug text-surface-400 {forecast.tone !== 'neutral'
                        ? 'pl-5'
                        : ''}"
                    data-testid="growth-precision">
                    {forecast.precision}
                </p>
            {/if}
        {/if}
    </div>
{/if}

<style>
    /* Short left-to-right reveal on first render; skipped for reduced motion. */
    .growth-reveal {
        animation: growth-reveal 600ms ease-out backwards;
    }
    @keyframes growth-reveal {
        from {
            clip-path: inset(-4px 100% -4px 0);
        }
        to {
            clip-path: inset(-4px -4px -4px 0);
        }
    }
    /* A soft glow on the measured line only: the part that is real data. */
    .growth-reveal :global(.growth-glow) {
        filter: drop-shadow(0 0 3px color-mix(in srgb, currentColor 55%, transparent));
    }
    @media (prefers-reduced-motion: reduce) {
        .growth-reveal {
            animation: none;
        }
    }
</style>
