<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /admin/fix/why-transcode — what the server actually decided, and why.

  ## Reports, never recomputes

  The planner already recorded its verdict and its reasons on every session row.
  This page renders those. Re-running the planner here would risk a second
  opinion that disagreed with what actually happened, which is worse than no
  page at all: the operator would be debugging a decision the server never made.

  ## A list, not a verdict

  Every other diagnostic on this surface answers with one verdict. This one
  cannot. The same file direct-plays to one client and full-transcodes to
  another, and which client it was IS the answer — collapsing that would hide
  the only variable that matters. The source streams sit above the list so the
  delivered codec can be read against what the file actually contains.
-->
<script lang="ts">
    import { page } from '$app/state';
    import FixPageShell from '$lib/components/admin/fix/FixPageShell.svelte';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import { findSymptom } from '$lib/components/admin/fix/symptoms.js';
    import {
        PlaybackDecisionSchema,
        type PlaybackDecision,
    } from '$lib/components/admin/fix/playback-decision.schema.js';
    import {
        RecentPlaysSchema,
        type RecentPlay,
    } from '$lib/components/admin/fix/recent-plays.schema.js';
    import { apiGet } from '$lib/api/client.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import * as m from '$lib/paraglide/messages.js';

    const symptom = findSymptom('why-transcode');

    let mediaId = $state(page.url.searchParams.get('mediaId') ?? '');
    let result = $state<PlaybackDecision | null>(null);
    let loading = $state(false);
    let loadError = $state<ClassifiedError | null>(null);
    let recent = $state<RecentPlay[]>([]);
    let recentFailed = $state(false);
    let invalidId = $state(false);

    /**
     * The API validates `mediaId` as a uuid and answers 422 for anything else.
     * That is correct, but a bare 422 is a dead end for someone who mistyped or
     * pasted a spliced id, so the shape is checked here and named in plain words
     * instead of being sent to fail.
     */
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    /** Recent playbacks, so an id never has to be typed. Failure is quiet: the
     *  page still works by pasting, and a broken picker must not look like a
     *  broken diagnostic — but it must not claim nothing was ever played. */
    async function loadRecent(): Promise<void> {
        const res = await apiGet('/api/admin/fix/recent-plays', RecentPlaysSchema, {
            strict: true,
        });
        recentFailed = !res.data;
        if (res.data) recent = res.data.plays;
    }

    $effect(() => {
        void loadRecent();
    });

    function pick(id: string): void {
        mediaId = id;
        void run();
    }

    /** Only the newest lookup may write the result; an older one finishing late is dropped. */
    let runSeq = 0;

    async function run(): Promise<void> {
        if (!mediaId.trim()) return;
        const seq = ++runSeq;
        invalidId = !UUID_RE.test(mediaId.trim());
        if (invalidId) {
            result = null;
            loadError = null;
            return;
        }
        loading = true;
        loadError = null;
        result = null;
        const params = new URLSearchParams({ mediaId: mediaId.trim() });
        const res = await apiGet(
            `/api/admin/fix/playback-decision?${params.toString()}`,
            PlaybackDecisionSchema,
            { strict: true },
        );
        if (seq !== runSeq) return;
        loading = false;
        if (res.data) {
            result = res.data;
        } else if (res.error) {
            loadError = classifyError(new Error(res.error), { status: res.status });
        }
    }

    function when(iso: string): string {
        return new Date(iso).toLocaleString();
    }

    /** Direct play and remux (a stream copy) are nearly free; the rest cost CPU. */
    function methodTone(method: string): string {
        return method === 'direct' || method === 'remux' ? 'text-success-300' : 'text-warning-300';
    }
</script>

{#if symptom}
    <FixPageShell title={symptom.title()} icon={symptom.icon}>
        <p class="max-w-3xl text-sm leading-relaxed text-surface-300">
            {m.admin_fix_playback_intro()}
        </p>

        <form
            class="flex flex-wrap items-end gap-3"
            onsubmit={(e) => {
                e.preventDefault();
                void run();
            }}>
            <label class="flex flex-col gap-1">
                <span class="text-xs text-surface-400">{m.admin_fix_playback_media_label()}</span>
                <input
                    bind:value={mediaId}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    class="w-80 rounded border border-surface-700 bg-surface-900 px-2 py-1 font-mono text-xs text-surface-100" />
            </label>
            <button
                type="submit"
                disabled={loading || !mediaId.trim()}
                class="rounded bg-primary-700 px-3 py-1.5 text-sm text-white hover:bg-primary-600 disabled:opacity-50">
                {m.admin_fix_playback_run()}
            </button>
        </form>
        <p class="text-xs text-surface-500">{m.admin_fix_playback_hint()}</p>

        {#if invalidId}
            <p class="text-sm text-warning-300">{m.admin_fix_playback_invalid_id()}</p>
        {/if}

        <section class="space-y-2">
            <h2 class="text-sm font-medium text-surface-100">
                {m.admin_fix_playback_recent_heading()}
            </h2>
            {#if recentFailed}
                <p class="text-xs text-warning-300">{m.admin_fix_playback_recent_failed()}</p>
            {:else if recent.length === 0}
                <p class="text-xs text-surface-500">{m.admin_fix_playback_recent_empty()}</p>
            {:else}
                <p class="text-xs text-surface-500">{m.admin_fix_playback_recent_hint()}</p>
                <ul class="divide-y divide-surface-800 rounded border border-surface-800">
                    {#each recent as r (r.mediaId)}
                        <li>
                            <button
                                type="button"
                                class="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-surface-800/60"
                                onclick={() => pick(r.mediaId)}>
                                <span class="text-sm text-surface-100">{r.mediaTitle}</span>
                                <span class="text-xs text-surface-400">
                                    {r.username ?? m.admin_fix_playback_recent_unknown_user()}
                                </span>
                                <span class="font-mono text-xs {methodTone(r.playMethod)}">
                                    {r.playMethod}
                                </span>
                                {#if r.clientName}
                                    <span class="text-xs text-surface-500">{r.clientName}</span>
                                {/if}
                                <span class="ml-auto text-xs text-surface-500">
                                    {when(r.startedAt)}
                                </span>
                            </button>
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>

        <AsyncSection {loading} error={loadError} onretry={() => void run()}>
            {#if result}
                <div class="space-y-6">
                    <h2 class="text-sm font-medium text-surface-100">{result.mediaTitle}</h2>

                    {#if result.sourceStreams.length > 0}
                        <section class="space-y-1">
                            <h3 class="text-sm font-medium text-surface-200">
                                {m.admin_fix_playback_source_heading()}
                            </h3>
                            <ul class="flex flex-wrap gap-1.5">
                                {#each result.sourceStreams as s, i (i)}
                                    <li
                                        class="rounded bg-surface-800 px-2 py-0.5 font-mono text-xs text-surface-300">
                                        {s.kind}: {s.codec ?? '?'}{s.profile
                                            ? ` (${s.profile})`
                                            : ''}{s.channels ? ` ${s.channels}ch` : ''}{s.language
                                            ? ` ${s.language}`
                                            : ''}
                                    </li>
                                {/each}
                            </ul>
                        </section>
                    {/if}

                    <section class="space-y-2">
                        <h3 class="text-sm font-medium text-surface-200">
                            {m.admin_fix_playback_sessions_heading()}
                        </h3>
                        <p class="max-w-3xl text-xs leading-relaxed text-surface-400">
                            {m.admin_fix_playback_note()}
                        </p>

                        {#if result.sessions.length === 0}
                            <p class="text-sm text-surface-300">
                                {m.admin_fix_playback_no_sessions()}
                            </p>
                        {:else}
                            <ul class="divide-y divide-surface-800">
                                {#each result.sessions as s (s.sessionId)}
                                    <li class="space-y-1 py-2.5">
                                        <div class="flex flex-wrap items-baseline gap-x-3">
                                            <span
                                                class="font-mono text-xs font-medium {methodTone(
                                                    s.playMethod,
                                                )}">
                                                {s.playMethod}
                                            </span>
                                            <span class="text-xs text-surface-300">
                                                {m.admin_fix_playback_client()}:
                                                {s.clientName ??
                                                    m.admin_fix_playback_unknown_client()}
                                                {s.clientVersion ?? ''}
                                            </span>
                                            {#if s.username}
                                                <span class="text-xs text-surface-400"
                                                    >{s.username}</span>
                                            {/if}
                                            <span class="text-xs text-surface-500"
                                                >{when(s.startedAt)}</span>
                                        </div>

                                        <p class="text-xs text-surface-400">
                                            {m.admin_fix_playback_delivered()}:
                                            {s.videoCodec ?? '?'} / {s.audioCodec ?? '?'}
                                            {s.container ? ` · ${s.container}` : ''}
                                            {s.resolution ? ` · ${s.resolution}` : ''}
                                            {s.bitrateKbps ? ` · ${s.bitrateKbps} kbps` : ''}
                                            {s.deliveryPath ? ` · ${s.deliveryPath}` : ''}
                                        </p>
                                        {#if s.transcodeCodec || s.subtitleMethod}
                                            <p class="text-xs text-surface-400">
                                                {#if s.transcodeCodec}
                                                    {m.admin_fix_playback_transcoded_to()}:
                                                    <span class="font-mono"
                                                        >{s.transcodeCodec}</span>
                                                {/if}
                                                {#if s.subtitleMethod}
                                                    {s.transcodeCodec
                                                        ? ' · '
                                                        : ''}{m.admin_fix_playback_subtitles()}:
                                                    <span class="font-mono"
                                                        >{s.subtitleMethod}</span>
                                                {/if}
                                            </p>
                                        {/if}

                                        {#if s.planReasons.length > 0}
                                            <div class="space-y-0.5">
                                                <p class="text-xs text-surface-400">
                                                    {m.admin_fix_playback_reasons_label()}:
                                                </p>
                                                <ul class="flex flex-wrap gap-1">
                                                    {#each s.planReasons as reason, i (i)}
                                                        <li
                                                            class="rounded bg-warning-900/30 px-1.5 py-0.5 font-mono text-xs text-warning-200">
                                                            {reason}
                                                        </li>
                                                    {/each}
                                                </ul>
                                            </div>
                                        {:else if !s.planRecorded}
                                            <p class="text-xs text-surface-500">
                                                {m.admin_fix_playback_no_plan()}
                                            </p>
                                        {:else if s.playMethod === 'direct'}
                                            <p class="text-xs text-surface-500">
                                                {m.admin_fix_playback_no_reasons()}
                                            </p>
                                        {/if}
                                    </li>
                                {/each}
                            </ul>
                        {/if}
                    </section>
                </div>
            {/if}
        </AsyncSection>
    </FixPageShell>
{/if}
