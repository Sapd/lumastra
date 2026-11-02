<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Renders the attempt timeline for one play session's transcode-failure chain
  and hosts the two copy-for-report buttons. All redaction goes through
  `formatFailureReport` in $lib/shared — never re-implemented here — so the
  same code path is exercised by the tests and by these buttons.
-->
<script lang="ts">
    import { SvelteSet, SvelteMap } from 'svelte/reactivity';
    import { Icon, ArrowTopRightOnSquare, ClipboardDocument } from 'svelte-hero-icons';
    import {
        formatFailureReport,
        type RedactOptions,
        type FailureReportInput,
    } from '$lib/shared/transcode-failure-report.js';
    import { TranscodeProbeResponseSchema } from '$lib/schemas/api-transcode-failures.js';
    import type { TranscodeFailureAttempt } from '$lib/schemas/api-transcode-failures.js';
    import { apiPost } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store';
    import { openMediaModalFromUrl } from '$lib/utils/modal-utils';
    import * as m from '$lib/paraglide/messages.js';
    import { resolve } from '$lib/paths';

    interface Props {
        attempts: TranscodeFailureAttempt[];
        roots: RedactOptions;
    }

    let { attempts, roots }: Props = $props();

    // Empty `libraryRoots` means `redactPaths` has nothing to match — every
    // library path would ride into a "redacted" GitHub report unredacted. The
    // headline safety property of the github-mode button must fail LOUD, not
    // silently ship an unredacted report under a button labelled "redacted".
    let redactionUnavailable = $derived(roots.libraryRoots.length === 0);

    // Writable $derived: recomputes fresh whenever the parent hands us a new
    // `attempts` array (a different session opened), but local mutations from
    // `loadProbe` below (merging in a lazily-fetched probe dump) stick until then.
    let localAttempts = $derived(attempts.map((a) => ({ ...a })));

    let probingIds = new SvelteSet<string>();
    let probeErrors = new SvelteMap<string, string>();

    /**
     * Fetch the `ffmpeg -i` source dump for one attempt on first expand of its
     * "Source" section. Runs once — the endpoint itself caches on the row, and
     * this only re-triggers a fetch if `probeDump` is still null.
     */
    async function loadProbe(attempt: TranscodeFailureAttempt): Promise<void> {
        if (attempt.probeDump !== null || probingIds.has(attempt.id)) return;

        probingIds.add(attempt.id);
        probeErrors.delete(attempt.id);

        const { data, error } = await apiPost(
            `/api/admin/transcode-failures/${encodeURIComponent(attempt.id)}/probe`,
            TranscodeProbeResponseSchema,
        );

        probingIds.delete(attempt.id);

        if (error || !data) {
            probeErrors.set(attempt.id, error ?? 'Failed to probe source');
            return;
        }

        if (data.probeDump !== null) {
            localAttempts = localAttempts.map((a) =>
                a.id === attempt.id ? { ...a, probeDump: data.probeDump } : a,
            );
        }
    }

    /**
     * `formatFailureReport` requires non-nullable text/JSON fields, while the
     * DB row (and therefore the DTO) allows null for anything that can go
     * unset (summary, stderr, source/decision/env). Fill in the same empty
     * defaults the report renderer already treats as "nothing to show".
     */
    function toReportInput(attempt: TranscodeFailureAttempt): FailureReportInput {
        return {
            category: attempt.category,
            summary: attempt.summary ?? '(no summary)',
            outcome: attempt.outcome,
            exitCode: attempt.exitCode,
            encoder: attempt.encoder,
            hwaccel: attempt.hwaccel,
            argv: attempt.argv,
            stderrTail: attempt.stderrTail ?? '',
            source: attempt.source ?? {},
            decision: attempt.decision ?? {},
            env: attempt.env ?? {},
            probeDump: attempt.probeDump,
            roots,
        };
    }

    async function copy(mode: 'github' | 'raw'): Promise<void> {
        const body = localAttempts
            .map((a) => formatFailureReport(toReportInput(a), mode))
            .join('\n\n---\n\n');
        await navigator.clipboard.writeText(body);
        toasts.success(mode === 'github' ? 'Copied (redacted)' : 'Copied (raw)');
    }

    // The capture deliberately skips seek/supersede teardown, so a chain can
    // legitimately end on a non-terminal `retried` row. That is expected, not
    // an error — it must never render as a spinner or an error state.
    let endsNonTerminal = $derived(
        localAttempts.length > 0 && localAttempts[localAttempts.length - 1].outcome === 'retried',
    );

    function formatTimestamp(iso: string): string {
        const parsed = new Date(iso);
        return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
    }

    function openMediaModal(mediaId: string): void {
        openMediaModalFromUrl({ internal: mediaId }, 'movie').catch(() => {
            toasts.error('This media item is no longer available');
        });
    }
</script>

<div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
        <button
            type="button"
            class="btn btn-sm variant-filled-primary inline-flex items-center gap-1"
            disabled={localAttempts.length === 0 || redactionUnavailable}
            title={redactionUnavailable
                ? 'Path redaction unavailable — no filesystem library roots are configured'
                : undefined}
            onclick={() => copy('github')}>
            <Icon src={ClipboardDocument} class="h-4 w-4" />
            <span>Copy for GitHub</span>
        </button>
        <button
            type="button"
            class="btn btn-sm variant-soft inline-flex items-center gap-1"
            disabled={localAttempts.length === 0}
            onclick={() => copy('raw')}>
            <Icon src={ClipboardDocument} class="h-4 w-4" />
            <span>Copy raw</span>
        </button>
    </div>
    {#if localAttempts.some((attempt) => (attempt.hwaccel && attempt.hwaccel !== 'none') || /nvenc|qsv|vaapi|amf|videotoolbox/i.test(attempt.encoder ?? '') || /gpu|hardware/i.test(attempt.category))}
        <a
            class="text-sm text-primary-300 underline"
            href={resolve('/admin/settings/playback?category=ffmpeg-hardware')}
            >{m.admin_hardware_configure()}</a>
    {/if}
    {#if redactionUnavailable}
        <p class="text-xs text-warning-300">
            Paths cannot be redacted because no filesystem library roots are configured — "Copy for
            GitHub" is disabled. "Copy raw" is still available for your own use.
        </p>
    {/if}

    {#if localAttempts.length === 0}
        <p class="text-sm italic text-surface-500">No attempts recorded for this session.</p>
    {:else}
        <ol class="space-y-3">
            {#each localAttempts as attempt (attempt.id)}
                <li class="rounded border border-surface-700/50 bg-surface-800/30 p-3">
                    <div class="flex flex-wrap items-center gap-2 text-xs text-surface-400">
                        <span class="font-mono text-surface-200">#{attempt.attempt}</span>
                        <span class="badge-soft-cyan">{attempt.outcome}</span>
                        <span>{attempt.category}</span>
                        {#if attempt.encoder}
                            <span>{attempt.encoder}</span>
                        {/if}
                        {#if attempt.hwaccel}
                            <span>{attempt.hwaccel}</span>
                        {/if}
                        <span>exit {attempt.exitCode ?? 'n/a'}</span>
                        {#if attempt.signal}
                            <span>signal {attempt.signal}</span>
                        {/if}
                        {#if attempt.transcodeSpeed !== null}
                            <span>{attempt.transcodeSpeed.toFixed(2)}× realtime</span>
                        {/if}
                        <span class="ml-auto whitespace-nowrap"
                            >{formatTimestamp(attempt.occurredAt)}</span>
                    </div>
                    {#if attempt.summary}
                        <p class="mt-2 text-sm text-surface-200">{attempt.summary}</p>
                    {/if}
                    <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                        <dt class="text-surface-500">Job</dt>
                        <dd><code class="break-all">{attempt.jobId}</code></dd>
                        <dt class="text-surface-500">Attempt event</dt>
                        <dd><code>{attempt.id}</code></dd>
                        {#if attempt.fileId}
                            <dt class="text-surface-500">Media file</dt>
                            <dd><code class="break-all">{attempt.fileId}</code></dd>
                        {/if}
                        {#if attempt.mediaId}
                            <dt class="text-surface-500">Media</dt>
                            <dd class="flex min-w-0 items-center gap-2">
                                <code class="min-w-0 break-all">{attempt.mediaId}</code>
                                <button
                                    type="button"
                                    class="shrink-0 text-primary-400 hover:underline"
                                    onclick={() => openMediaModal(attempt.mediaId!)}>Open</button>
                                <a
                                    href={resolve(`/admin/library/media/${attempt.mediaId}`)}
                                    class="shrink-0 text-surface-400 hover:text-surface-100"
                                    title="Open in admin media">
                                    <Icon src={ArrowTopRightOnSquare} class="h-3.5 w-3.5" />
                                </a>
                            </dd>
                        {/if}
                    </dl>
                    <details class="mt-2 text-xs text-surface-400">
                        <summary class="cursor-pointer">FFmpeg command</summary>
                        <pre
                            class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-surface-300">{attempt.argv.join(
                                ' ',
                            )}</pre>
                    </details>
                    {#if attempt.decision}
                        <details class="mt-2 text-xs text-surface-400">
                            <summary class="cursor-pointer">Transcode decision</summary>
                            <pre
                                class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-surface-300">{JSON.stringify(
                                    attempt.decision,
                                    null,
                                    2,
                                )}</pre>
                        </details>
                    {/if}
                    {#if attempt.env}
                        <details class="mt-2 text-xs text-surface-400">
                            <summary class="cursor-pointer">Runtime environment</summary>
                            <pre
                                class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-surface-300">{JSON.stringify(
                                    attempt.env,
                                    null,
                                    2,
                                )}</pre>
                        </details>
                    {/if}
                    {#if attempt.stderrTail}
                        <details class="mt-2 text-xs text-surface-400">
                            <summary class="cursor-pointer">stderr</summary>
                            <pre
                                class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-surface-300">{attempt.stderrTail}</pre>
                        </details>
                    {/if}
                    <details
                        class="mt-2 text-xs text-surface-400"
                        ontoggle={(e) => {
                            if (e.currentTarget.open) void loadProbe(attempt);
                        }}>
                        <summary class="cursor-pointer">Source</summary>
                        {#if probingIds.has(attempt.id)}
                            <p class="mt-1 italic text-surface-500">Probing source…</p>
                        {:else if probeErrors.has(attempt.id)}
                            <p class="mt-1 text-error-400">{probeErrors.get(attempt.id)}</p>
                        {:else if attempt.probeDump}
                            <pre
                                class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-surface-300">{attempt.probeDump}</pre>
                        {:else}
                            <p class="mt-1 italic text-surface-500">No source probe available.</p>
                        {/if}
                    </details>
                </li>
            {/each}
        </ol>

        {#if endsNonTerminal}
            <p class="text-xs italic text-surface-500">
                No further attempts recorded — the chain ends on a retry with nothing after it.
            </p>
        {/if}
    {/if}
</div>
