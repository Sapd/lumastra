<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /admin/fix/new-files — the highest-value diagnostic on this surface.

  It RUNS the checks and shows what is true, rather than listing what the
  operator should go and check. Everything here was measured on this instance as
  the page loaded: whether scanning is switched on and when it last fired,
  whether each configured folder exists and is readable right now, the uid this
  process runs as against the folder's real owner and mode, what the last scan
  actually found, and where those results currently sit in processing.

  Fetched client-side rather than in a `+page.server.ts` load on purpose: the
  probes touch the filesystem, and the case worth diagnosing is a hung network
  mount. An SSR load would make the page that explains the hang hang with it.
  AsyncSection supplies the loading/timeout/error contract instead.
-->
<script lang="ts">
    import { Icon, ArrowPath } from 'svelte-hero-icons';
    import FixPageShell from '$lib/components/admin/fix/FixPageShell.svelte';
    import PathCheckCard from '$lib/components/admin/fix/PathCheckCard.svelte';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import { findSymptom } from '$lib/components/admin/fix/symptoms.js';
    import {
        LibraryScanCheckSchema,
        type LibraryScanCheck,
    } from '$lib/components/admin/fix/library-scan-check.schema.js';
    import { apiGet } from '$lib/api/client.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    const symptom = findSymptom('new-files');

    let report = $state<LibraryScanCheck | null>(null);
    let loading = $state(false);
    let loadError = $state<ClassifiedError | null>(null);

    async function load(): Promise<void> {
        loading = true;
        loadError = null;
        const { data, error, status } = await apiGet(
            '/api/admin/fix/library-scan-check',
            LibraryScanCheckSchema,
            { strict: true },
        );
        loading = false;
        if (error || !data) {
            loadError = classifyError(new Error(error ?? undefined), { status });
            return;
        }
        // A 200 carrying dbError has empty paths and default schedule fields.
        // Rendered, it reads "no library folders are configured" — a confident
        // wrong diagnosis on exactly the "my library is empty" visit.
        if (data.dbError !== null) {
            report = null;
            loadError = classifyError(new Error(data.dbError), { status: 503 });
            return;
        }
        report = data;
    }

    $effect(() => {
        void load();
    });

    function when(iso: string | null): string {
        return iso === null ? m.admin_fix_files_scan_never_fired() : new Date(iso).toLocaleString();
    }

    /** Coarse, human duration for "the longest-waiting item has been waiting …". */
    function humanAge(seconds: number): string {
        if (seconds < 90) return `${Math.round(seconds)}s`;
        if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
        if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
        return `${Math.round(seconds / 86400)}d`;
    }

    let schedule = $derived(report?.schedule ?? null);
    let paths = $derived(report?.paths ?? []);
    let pipeline = $derived(report?.pipeline ?? null);
</script>

{#if symptom}
    <FixPageShell
        title={symptom.title()}
        description={m.admin_fix_files_description()}
        icon={symptom.icon}>
        <div class="space-y-6">
            <div class="flex items-center gap-2">
                <button
                    type="button"
                    class="btn btn-sm variant-soft inline-flex items-center gap-1"
                    disabled={loading}
                    onclick={() => void load()}>
                    <Icon src={ArrowPath} class="h-4 w-4" />
                    <span>{m.admin_fix_files_refresh()}</span>
                </button>
            </div>

            <AsyncSection
                {loading}
                error={loadError}
                empty={report === null && !loading && loadError === null}
                onretry={() => void load()}>
                {#if report !== null && schedule !== null}
                    <div class="space-y-6">
                        <!-- 1. Is scanning even switched on? Everything below is
                             moot when it is not, so it is answered first. -->
                        <section class="space-y-2">
                            <h3 class="text-sm font-semibold text-surface-100">
                                {m.admin_fix_files_scan_heading()}
                            </h3>
                            {#if schedule.globallyDisabled}
                                <div
                                    class="space-y-1 rounded border border-error-500/40 bg-error-500/10 p-3">
                                    <p class="text-sm text-error-200">
                                        {m.admin_fix_files_scan_disabled()}
                                    </p>
                                    <p class="text-xs text-surface-300">
                                        {m.admin_fix_files_scan_disabled_how()}
                                    </p>
                                </div>
                            {:else if schedule.paused}
                                <div
                                    class="space-y-1 rounded border border-warning-500/40 bg-warning-500/10 p-3">
                                    <p class="text-sm text-warning-200">
                                        {m.admin_fix_files_scan_paused()}
                                    </p>
                                    {#if schedule.pausedBy !== null}
                                        <p class="text-xs text-surface-300">
                                            {m.admin_fix_files_scan_paused_by({
                                                who: schedule.pausedBy,
                                            })}
                                        </p>
                                    {/if}
                                </div>
                            {:else if schedule.unreadable}
                                <p class="text-sm text-warning-200">
                                    {m.admin_fix_files_scan_unreadable()}
                                </p>
                            {:else if schedule.neverScheduled}
                                <p class="text-sm text-surface-300">
                                    {m.admin_fix_files_scan_never()}
                                </p>
                            {:else}
                                <p class="text-sm text-surface-200">
                                    {m.admin_fix_files_scan_on()}
                                </p>
                            {/if}

                            {#if !schedule.neverScheduled && !schedule.unreadable}
                                <dl class="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                                    <div class="flex gap-1">
                                        <dt class="text-surface-400">
                                            {m.admin_fix_files_scan_last()}:
                                        </dt>
                                        <dd class="text-surface-200">
                                            {when(schedule.lastFiredAt)}
                                        </dd>
                                    </div>
                                    <div class="flex gap-1">
                                        <dt class="text-surface-400">
                                            {m.admin_fix_files_scan_next()}:
                                        </dt>
                                        <dd class="text-surface-200">
                                            {when(schedule.nextFireAt)}
                                        </dd>
                                    </div>
                                </dl>
                            {/if}
                        </section>

                        <!-- 2. The folders themselves, plus who this process is.
                             The identity line sits ABOVE the cards because every
                             permission remedy inside them is built from it. -->
                        <section class="space-y-3">
                            <h3 class="text-sm font-semibold text-surface-100">
                                {m.admin_fix_files_paths_heading()}
                            </h3>
                            <p class="text-xs text-surface-400">
                                {#if report.process.uid === null || report.process.gid === null}
                                    {m.admin_fix_files_process_unknown()}
                                {:else}
                                    {m.admin_fix_files_process_line({
                                        uid: report.process.uid,
                                        gid: report.process.gid,
                                    })}
                                {/if}
                            </p>

                            {#if paths.length === 0}
                                <p class="text-sm text-surface-300">
                                    {m.admin_fix_files_paths_none()}
                                </p>
                                <a
                                    href={resolve('/admin/library/sources')}
                                    class="btn btn-sm variant-filled-primary inline-flex">
                                    {m.admin_fix_link_sources()}
                                </a>
                            {:else}
                                <div class="space-y-3">
                                    {#each paths as path (path.id)}
                                        <PathCheckCard
                                            report={path}
                                            processUid={report.process.uid}
                                            processGid={report.process.gid}
                                            onchanged={() => void load()} />
                                    {/each}
                                </div>
                            {/if}
                        </section>

                        <!-- 3. Found, but not visible yet: where it currently is. -->
                        {#if pipeline !== null}
                            <section class="space-y-2">
                                <h3 class="text-sm font-semibold text-surface-100">
                                    {m.admin_fix_files_pipeline_heading()}
                                </h3>
                                {#if pipeline.inFlight === 0 && pipeline.running === 0}
                                    <p class="text-sm text-surface-300">
                                        {m.admin_fix_files_pipeline_idle()}
                                    </p>
                                {:else}
                                    <p class="text-sm text-surface-200">
                                        {m.admin_fix_files_pipeline_body({
                                            inFlight: pipeline.inFlight,
                                            running: pipeline.running,
                                        })}
                                    </p>
                                    {#if pipeline.oldestPendingAgeSec !== null}
                                        <p class="text-xs text-surface-400">
                                            {m.admin_fix_files_pipeline_oldest({
                                                age: humanAge(pipeline.oldestPendingAgeSec),
                                            })}
                                        </p>
                                    {/if}
                                {/if}
                                {#if pipeline.failedLastHour > 0 || pipeline.deadLetterItems > 0}
                                    <p class="text-xs text-warning-200">
                                        {m.admin_fix_files_pipeline_failed({
                                            failed: pipeline.failedLastHour,
                                            dead: pipeline.deadLetterItems,
                                        })}
                                    </p>
                                {/if}
                                <a
                                    href={resolve('/admin/tasks/pipeline')}
                                    class="inline-block text-xs text-primary-400 hover:underline">
                                    {m.admin_fix_link_pipeline()}
                                </a>
                            </section>
                        {/if}
                    </div>
                {/if}
            </AsyncSection>
        </div>
    </FixPageShell>
{/if}
