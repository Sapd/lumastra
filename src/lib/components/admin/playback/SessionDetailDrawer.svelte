<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    import type { SpeedTestResultResponse } from '$lib/schemas/api-network-responses.js';

    export interface PlaybackQualitySessionDetail {
        sessionId: string;
        startedAt: string;
        healthScore?: number | null;
        playMethod?: string | null;
        /** Device class: mobile / tablet / tv / desktop / unknown. */
        deviceType?: string | null;
        /** What was played; an episode reads "Series · S1E2 · Episode". */
        mediaTitle?: string | null;
        /** The device's display name (web clients report their UA here). */
        deviceName?: string | null;
        issues?: string[] | null;
        rootCause?: string | null;
        scoringModelVersion?: number | null;
        /**
         * Receiver-timed delivery throughput for this session, bits/s. Both
         * percentiles are carried on purpose: a link that is usually ample and
         * periodically collapses shows a low p10 beside a healthy p50, which no
         * single average can reveal — hence "worst / typical" in the row.
         */
        deliveryP10Bps?: number | null;
        deliveryP50Bps?: number | null;
        /** How many 30 s windows the client reported (a COUNT, not a list). */
        deliveryWindows?: number | null;
        /** Segment downloads the player reported as late (native players only). */
        deliveryOverdue?: number | null;
    }

    export interface DeliveryPercentiles {
        p50Ms?: number | null;
        p95Ms?: number | null;
        p99Ms?: number | null;
        sampleCount?: number | null;
    }

    export interface SessionDetailResponse {
        sessions: PlaybackQualitySessionDetail[];
        deliveryPercentiles?: DeliveryPercentiles | null;
        /**
         * The user's own ACTIVE measurements, newest first. Present on the
         * per-user endpoint only — the per-device one has no user to attribute a
         * speed test to, so the strip simply does not render there.
         */
        speedTests?: SpeedTestResultResponse[] | null;
    }
</script>

<script lang="ts">
    import { onDestroy } from 'svelte';
    import * as m from '$lib/paraglide/messages';
    import { trapFocus } from '$lib/utils/focus-trap';
    import HealthScoreBadge from './badges/HealthScoreBadge.svelte';
    import PlayMethodBadge from './badges/PlayMethodBadge.svelte';
    import IssueBadge from './badges/IssueBadge.svelte';
    import FormFactorIcon from './badges/FormFactorIcon.svelte';
    import { Z } from '$lib/utils/z-index';
    import {
        formatMbit,
        formatSpeedTestMode,
        getFormFactorLabel,
        getFriendlyDeviceName,
    } from '$lib/utils/admin/playback-formatters';

    interface Props {
        endpoint: string;
        label: string;
        onclose: () => void;
    }

    let { endpoint, label, onclose }: Props = $props();

    let currentController: AbortController | null = null;
    let retryRevision = $state(0);
    onDestroy(() => currentController?.abort());

    async function fetchDetail(): Promise<SessionDetailResponse> {
        if (currentController) {
            currentController.abort();
        }
        currentController = new AbortController();
        const signal = currentController.signal;
        try {
            const res = await fetch(endpoint, { signal });
            if (!res.ok) {
                throw new Error(`Failed to load session detail (${res.status})`);
            }
            return res.json() as Promise<SessionDetailResponse>;
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                return new Promise(() => {});
            }
            throw err;
        }
    }

    let detailPromise = $derived.by(() => {
        // A failed request can be retried without dismissing the diagnostic context.
        void retryRevision;
        return fetchDetail();
    });

    function formatDate(iso: string): string {
        try {
            return new Date(iso).toLocaleString();
        } catch {
            return iso;
        }
    }

    /**
     * Whether this session carries any receiver-timed delivery evidence. A
     * session with windows but NULL percentiles still renders — "—/—" says the
     * client reported windows we could not summarise, which is information;
     * hiding the row would say the client reported nothing.
     */
    function hasDelivery(session: PlaybackQualitySessionDetail): boolean {
        return (
            session.deliveryP10Bps != null ||
            session.deliveryP50Bps != null ||
            (session.deliveryWindows ?? 0) > 0
        );
    }

    function formatTimestamp(iso: string): string {
        const parsed = new Date(iso);
        return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
    }

    function handleKeyDown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            onclose();
        }
    }
</script>

<svelte:window onkeydown={handleKeyDown} />

<!-- Backdrop — Z.MODAL so it sits above the fixed navbar (Z.NAVBAR=500) and
     sidebar dock (Z.SIDEBAR_DOCK=100); Tailwind z-40 left those painting over
     the drawer, hiding its header and eating clicks on the close button. -->
<div
    class="fixed inset-0 bg-black/60"
    style="z-index: {Z.MODAL}"
    role="button"
    tabindex="-1"
    aria-label={m.admin_redesign_sessions_close()}
    onclick={onclose}
    onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onclose();
    }}>
</div>

<!-- Drawer panel — one above its backdrop (mirrors ModalContainer's MODAL / MODAL+1 split) -->
<div
    use:trapFocus
    class="fixed right-0 top-0 h-full w-full max-w-2xl bg-surface-900 border-l border-surface-700 shadow-2xl flex flex-col"
    style="z-index: {Z.MODAL + 1}"
    role="dialog"
    aria-modal="true"
    aria-label={m.admin_redesign_sessions_detail_for({ label })}
    tabindex="-1">
    <!-- Header -->
    <div
        class="flex items-center justify-between px-6 py-4 border-b border-surface-700 flex-shrink-0">
        <div class="min-w-0">
            <h2 class="text-lg font-semibold text-white">
                {m.admin_redesign_sessions_detail_title()}
            </h2>
            <p class="text-sm text-surface-400 mt-0.5 truncate">{label}</p>
        </div>
        <button
            class="p-2 rounded-lg hover:bg-surface-700 transition-colors text-surface-400 hover:text-white"
            onclick={onclose}
            aria-label={m.admin_redesign_sessions_close()}>
            <svg
                class="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true">
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M6 18L18 6M6 6l12 12" />
            </svg>
        </button>
    </div>

    <!-- Content -->
    <div class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 sm:px-6 py-4">
        <p class="mb-5 text-sm text-surface-400">{m.admin_redesign_sessions_detail_note()}</p>
        {#await detailPromise}
            <div class="flex items-center justify-center py-16 text-surface-400">
                <svg
                    class="w-5 h-5 animate-spin mr-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    aria-hidden="true">
                    <circle
                        class="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        stroke-width="4"></circle>
                    <path
                        class="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                {m.admin_redesign_sessions_loading()}
            </div>
        {:then data}
            <div class="mb-5 grid grid-cols-2 gap-3">
                <div class="rounded-xl border border-surface-700 bg-surface-800/50 p-3">
                    <p class="text-xs text-surface-400">{m.admin_redesign_sessions_recent()}</p>
                    <p class="mt-1 text-2xl font-semibold text-white">
                        {(data.sessions ?? []).length}
                    </p>
                </div>
                <div class="rounded-xl border border-surface-700 bg-surface-800/50 p-3">
                    <p class="text-xs text-surface-400">
                        {m.admin_redesign_sessions_with_issues()}
                    </p>
                    <p class="mt-1 text-2xl font-semibold text-amber-200">
                        {(data.sessions ?? []).filter(
                            (session) => (session.issues?.length ?? 0) > 0,
                        ).length}
                    </p>
                </div>
            </div>
            {#if data.deliveryPercentiles}
                {@const p = data.deliveryPercentiles}
                <div class="mb-6">
                    <h3 class="text-sm font-medium text-surface-300">
                        {m.admin_redesign_sessions_delivery_percentiles()}
                    </h3>
                    <!-- Scoped to THIS user's / device's sessions (it used to be the
                         fleet's, shown under the user's name). -->
                    <p class="text-xs text-surface-500 mt-0.5 mb-3">
                        {m.admin_pbquality_drawer_delivery_hint()}
                    </p>
                    <div class="grid grid-cols-3 gap-3">
                        {#each [{ label: 'p50', ms: p.p50Ms }, { label: 'p95', ms: p.p95Ms }, { label: 'p99', ms: p.p99Ms }] as pct (pct.label)}
                            <div
                                class="bg-surface-800/60 border border-surface-700 rounded-lg px-3 py-2 text-center">
                                <div class="text-xs text-surface-400">{pct.label}</div>
                                <div class="text-sm font-medium text-white mt-0.5">
                                    {pct.ms != null ? `${Math.round(pct.ms)} ms` : '—'}
                                </div>
                            </div>
                        {/each}
                    </div>
                    {#if p.sampleCount != null}
                        <div class="text-xs text-surface-500 mt-2 text-right">
                            {m.admin_redesign_sessions_samples({ count: p.sampleCount })}
                        </div>
                    {/if}
                </div>
            {/if}

            {#if (data.sessions ?? []).length === 0}
                <div class="text-center py-12 text-surface-400">
                    {m.admin_redesign_sessions_no_history()}
                </div>
            {:else}
                <h3 class="text-sm font-medium text-surface-300 mb-3">
                    {m.admin_redesign_sessions_recent()} ({(data.sessions ?? []).length})
                </h3>
                <div class="space-y-3">
                    {#each data.sessions ?? [] as session (session.sessionId)}
                        <div
                            class="bg-surface-800/50 border border-surface-700 rounded-xl px-4 py-3">
                            {#if session.mediaTitle}
                                <p
                                    class="mb-1.5 text-sm font-medium text-white truncate"
                                    title={session.mediaTitle}>
                                    {session.mediaTitle}
                                </p>
                            {/if}
                            <div class="flex items-start justify-between gap-3 flex-wrap">
                                <div class="flex items-center gap-2 flex-wrap">
                                    {#if session.healthScore != null}
                                        <HealthScoreBadge
                                            score={session.healthScore}
                                            variant="pill" />
                                    {:else}
                                        <span class="text-xs text-surface-400"
                                            >{m.admin_redesign_sessions_score_unavailable()}</span>
                                    {/if}
                                    {#if session.playMethod}
                                        <PlayMethodBadge method={session.playMethod} />
                                    {/if}
                                </div>
                                <time
                                    class="text-xs text-surface-400 whitespace-nowrap"
                                    datetime={session.startedAt}>
                                    {formatDate(session.startedAt)}
                                </time>
                            </div>

                            {#if hasDelivery(session)}
                                <div
                                    class="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs tabular-nums">
                                    <span class="text-surface-500"
                                        >{m.admin_redesign_sessions_delivery()}</span>
                                    <span class="font-medium text-white">
                                        {formatMbit(session.deliveryP10Bps)} / {formatMbit(
                                            session.deliveryP50Bps,
                                        )} Mbit/s
                                    </span>
                                    {#if (session.deliveryWindows ?? 0) > 0}
                                        <span class="text-surface-500">
                                            {m.admin_redesign_sessions_windows({
                                                count: session.deliveryWindows ?? 0,
                                            })}
                                        </span>
                                    {/if}
                                    {#if (session.deliveryOverdue ?? 0) > 0}
                                        <span class="text-warning-400">
                                            {m.admin_redesign_sessions_overdue({
                                                count: session.deliveryOverdue ?? 0,
                                            })}
                                        </span>
                                    {/if}
                                </div>
                            {/if}

                            {#if session.issues && session.issues.length > 0}
                                <div class="flex flex-wrap gap-1.5 mt-2">
                                    {#each session.issues as issue (issue)}
                                        <IssueBadge {issue} />
                                    {/each}
                                </div>
                            {/if}

                            {#if session.rootCause}
                                <div class="mt-2 text-xs text-surface-400">
                                    <span class="text-surface-500"
                                        >{m.admin_redesign_sessions_root_cause()}</span>
                                    <span class="text-red-400 ml-1">{session.rootCause}</span>
                                </div>
                            {/if}

                            {#if session.deviceType || session.deviceName}
                                <div
                                    class="mt-1.5 flex items-center gap-1.5 text-xs text-surface-400">
                                    <FormFactorIcon
                                        formFactor={session.deviceType}
                                        class="w-3.5 h-3.5" />
                                    <span>{getFormFactorLabel(session.deviceType)}</span>
                                    {#if session.deviceName}
                                        <span class="text-surface-600" aria-hidden="true">·</span>
                                        <span class="truncate" title={session.deviceName}
                                            >{getFriendlyDeviceName(
                                                session.deviceName,
                                                null,
                                            )}</span>
                                    {/if}
                                </div>
                            {/if}

                            <div
                                class="mt-1 text-xs text-surface-600 font-mono truncate"
                                title={session.sessionId}>
                                {session.sessionId}
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}

            {#if (data.speedTests ?? []).length > 0}
                <div class="mt-6">
                    <h3 class="text-sm font-medium text-surface-300 mb-1">
                        {m.admin_redesign_sessions_speed_tests()}
                    </h3>
                    <p class="text-xs text-surface-500 mb-2">
                        {m.admin_redesign_sessions_speed_note()}
                    </p>
                    <ol class="space-y-1">
                        {#each data.speedTests ?? [] as speedTest (speedTest.id)}
                            <li
                                class="rounded border border-surface-700/50 bg-surface-800/30 p-2 text-xs tabular-nums">
                                <span
                                    class="rounded bg-surface-700/60 px-1 text-surface-300"
                                    title={m.admin_pbquality_speed_mode_hint()}>
                                    {formatSpeedTestMode(speedTest.mode)}
                                </span>
                                <span class="ml-2 text-surface-200"
                                    >{formatMbit(speedTest.throughputBps)} Mbit/s</span>
                                <span class="ml-2 text-surface-400"
                                    >{m.admin_pbquality_speed_first_byte({
                                        ms: Math.round(speedTest.ttfbMs),
                                    })}</span>
                                {#if speedTest.mode === 'cadence'}
                                    <!-- No buckets were recorded for a cadence
                                         run, so the worst SEGMENT replaces the
                                         slowest quarter-second and the stall. -->
                                    <span class="ml-2 text-surface-400"
                                        >{m.admin_pbquality_speed_worst_segment({
                                            mbit: formatMbit(speedTest.minRequestBps),
                                        })}</span>
                                    <span class="ml-2 text-surface-400"
                                        >{m.admin_pbquality_speed_worst_ttfb({
                                            ms:
                                                speedTest.maxTtfbMs === null
                                                    ? '—'
                                                    : String(Math.round(speedTest.maxTtfbMs)),
                                        })}</span>
                                {:else}
                                    <span class="ml-2 text-surface-400"
                                        >{m.admin_pbquality_speed_slowest_bucket({
                                            mbit: formatMbit(speedTest.minBucketBps),
                                        })}</span>
                                    <span class="ml-2 text-surface-400"
                                        >{m.admin_pbquality_speed_stalled({
                                            ms: Math.round(speedTest.stallMs),
                                        })}</span>
                                {/if}
                                {#if speedTest.aborted}
                                    <span class="ml-2 text-warning-400"
                                        >{m.admin_pbquality_speed_gave_up()}</span>
                                {/if}
                                <span class="ml-2 text-surface-500"
                                    >{formatTimestamp(speedTest.createdAt)}</span>
                            </li>
                        {/each}
                    </ol>
                </div>
            {/if}
        {:catch error}
            <div class="flex flex-col items-center justify-center py-16 text-center">
                <div class="text-red-400 mb-2">
                    <svg
                        class="w-8 h-8 mx-auto"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    </svg>
                </div>
                <p class="text-red-400 font-medium">{m.admin_redesign_sessions_detail_failed()}</p>
                <p class="text-surface-500 text-sm mt-1">
                    {error instanceof Error
                        ? error.message
                        : m.admin_redesign_sessions_unavailable()}
                </p>
                <button
                    type="button"
                    onclick={() => retryRevision++}
                    class="mt-4 rounded-lg border border-surface-600 px-4 py-2 text-sm text-white hover:bg-surface-800"
                    >{m.admin_redesign_sessions_retry()}</button>
            </div>
        {/await}
    </div>
</div>
