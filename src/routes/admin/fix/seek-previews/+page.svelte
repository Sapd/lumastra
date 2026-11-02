<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /admin/fix/seek-previews — do the thumbnails exist, and if not, why not?

  ## The number this page exists for is "never queued", not "queue depth"

  Counting stage rows by status answers "how is the work going". It cannot answer
  "was the work ever asked for": an item with NO row contributes to no bucket, so
  it is invisible to every status count and to the progress bar built from them.
  A prod incident left 11,186 items with no trickplay coverage while every
  dashboard read clean. That number is therefore reported FIRST, in its own
  block, phrased as "never queued" rather than folded into a queue total where it
  would look like patience was all that was needed.

  ## Deliberately does not judge whether the queue is stuck

  Trickplay is genuinely slow; hours on a fresh library is normal, so depth alone
  proves nothing. Rather than invent a second opinion about pipeline movement,
  this page states that plainly and links to the page that measures throughput —
  two pages describing one instance must not disagree about whether it is moving.
-->
<script lang="ts">
    import { Icon, ArrowPath, ExclamationTriangle, CheckCircle } from 'svelte-hero-icons';
    import FixPageShell from '$lib/components/admin/fix/FixPageShell.svelte';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import { findSymptom } from '$lib/components/admin/fix/symptoms.js';
    import {
        TrickplayCheckSchema,
        type TrickplayCheck,
    } from '$lib/components/admin/fix/trickplay-check.schema.js';
    import { apiGet } from '$lib/api/client.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    const symptom = findSymptom('seek-previews');

    let check = $state<TrickplayCheck | null>(null);
    let loading = $state(false);
    let loadError = $state<ClassifiedError | null>(null);

    async function load(): Promise<void> {
        loading = true;
        loadError = null;
        const res = await apiGet('/api/admin/fix/trickplay-check', TrickplayCheckSchema, {
            strict: true,
        });
        loading = false;
        if (res.data) {
            check = res.data;
        } else if (res.error) {
            loadError = classifyError(new Error(res.error), { status: res.status });
        }
    }

    $effect(() => {
        void load();
    });

    function day(iso: string | null): string {
        return iso ? new Date(iso).toLocaleDateString() : '—';
    }

    const queueRows = $derived.by(() =>
        check
            ? [
                  {
                      id: 'completed',
                      label: m.admin_fix_trickplay_completed(),
                      value: check.completed,
                  },
                  { id: 'pending', label: m.admin_fix_trickplay_pending(), value: check.pending },
                  { id: 'running', label: m.admin_fix_trickplay_running(), value: check.running },
                  {
                      id: 'failed-transient',
                      label: m.admin_fix_trickplay_failed_transient(),
                      value: check.failedTransient,
                  },
                  {
                      id: 'failed-permanent',
                      label: m.admin_fix_trickplay_failed_permanent(),
                      value: check.failedPermanent,
                  },
                  { id: 'skipped', label: m.admin_fix_trickplay_skipped(), value: check.skipped },
                  {
                      id: 'obsolete',
                      label: m.admin_fix_trickplay_obsolete(),
                      value: check.obsolete,
                  },
              ]
            : [],
    );
</script>

{#if symptom}
    <FixPageShell title={symptom.title()} icon={symptom.icon}>
        <div class="flex justify-end">
            <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded border border-surface-700 px-2.5 py-1 text-xs text-surface-300 hover:bg-surface-800 disabled:opacity-50"
                disabled={loading}
                onclick={() => void load()}>
                <Icon src={ArrowPath} class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
                {m.admin_fix_trickplay_refresh()}
            </button>
        </div>

        <AsyncSection {loading} error={loadError} onretry={() => void load()}>
            {#if check}
                <div class="space-y-6">
                    <!-- Either one explains 0% on its own, so it is answered
                         before any queue number could be read as a backlog. -->
                    {#if !check.generationEnabled || check.provider === 'jellyfin_disk'}
                        <div
                            class="flex items-start gap-3 rounded-lg border border-warning-700/60 bg-warning-900/20 p-4">
                            <Icon
                                src={ExclamationTriangle}
                                class="mt-0.5 h-5 w-5 shrink-0 text-warning-300" />
                            <div class="space-y-1">
                                <p class="text-sm text-surface-200">
                                    {check.provider === 'jellyfin_disk'
                                        ? m.admin_fix_trickplay_provider_jellyfin()
                                        : m.admin_fix_trickplay_generation_off()}
                                </p>
                                <a
                                    href={resolve('/admin/settings/media')}
                                    class="text-xs text-primary-300 hover:text-primary-200">
                                    {m.admin_fix_link_media_settings()}
                                </a>
                            </div>
                        </div>
                    {/if}

                    {#if !check.taskRegistered}
                        <div
                            class="flex items-start gap-3 rounded-lg border border-warning-700/60 bg-warning-900/20 p-4">
                            <Icon
                                src={ExclamationTriangle}
                                class="mt-0.5 h-5 w-5 shrink-0 text-warning-300" />
                            <p class="text-sm text-surface-200">
                                {m.admin_fix_trickplay_not_registered()}
                            </p>
                        </div>
                    {/if}

                    <section class="space-y-2">
                        <h2 class="text-sm font-medium text-surface-200">
                            {m.admin_fix_trickplay_heading()}
                        </h2>
                        <p class="text-sm text-surface-200">
                            {m.admin_fix_trickplay_coverage({
                                percent: check.coveragePercent,
                                completed: check.completed,
                                eligible: check.eligibleItems,
                            })}
                        </p>
                        <p class="text-xs text-surface-400">
                            {check.taskLastFiredAt
                                ? m.admin_fix_trickplay_lastrun({
                                      when: day(check.taskLastFiredAt),
                                  })
                                : check.taskLastFiredUnreadable
                                  ? m.admin_fix_trickplay_lastrun_unreadable()
                                  : m.admin_fix_trickplay_lastrun_never()}
                        </p>
                        {#if check.taskPaused === null}
                            <p class="text-sm text-warning-300">
                                {m.admin_fix_trickplay_paused_unknown()}
                            </p>
                        {:else if check.taskPaused}
                            <p class="flex items-start gap-1.5 text-sm text-warning-300">
                                <Icon src={ExclamationTriangle} class="mt-0.5 h-4 w-4 shrink-0" />
                                <span>{m.admin_fix_trickplay_paused_warn()}</span>
                            </p>
                        {/if}
                    </section>

                    <!--
                      Reported first and on its own: these items are not waiting,
                      they were never asked for, and folding them into a queue
                      total would make patience look like the remedy.
                    -->
                    {#if check.withoutRow > 0}
                        <section
                            class="flex items-start gap-3 rounded-lg border border-error-700/60 bg-error-900/20 p-4">
                            <Icon
                                src={ExclamationTriangle}
                                class="mt-0.5 h-5 w-5 shrink-0 text-error-300" />
                            <div class="space-y-1">
                                <p class="text-sm font-medium text-surface-100">
                                    {m.admin_fix_trickplay_never_queued_title({
                                        count: check.withoutRow,
                                    })}
                                </p>
                                <p class="text-sm leading-relaxed text-surface-300">
                                    {m.admin_fix_trickplay_never_queued_body()}
                                </p>
                            </div>
                        </section>
                    {:else if check.generationEnabled && check.provider !== 'jellyfin_disk'}
                        <p class="flex items-center gap-2 text-sm text-surface-300">
                            <Icon src={CheckCircle} class="h-4 w-4 shrink-0 text-success-300" />
                            {m.admin_fix_trickplay_all_queued()}
                        </p>
                    {/if}

                    <section class="space-y-2">
                        <h2 class="text-sm font-medium text-surface-200">
                            {m.admin_fix_trickplay_queue_heading()}
                        </h2>
                        <p class="max-w-3xl text-xs leading-relaxed text-surface-400">
                            {m.admin_fix_trickplay_slow_note()}
                            <a
                                href={resolve('/admin/fix/stuck')}
                                class="ml-1 text-primary-300 hover:text-primary-200">
                                {m.admin_fix_trickplay_is_it_moving()}
                            </a>
                        </p>
                        <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                            {#each queueRows as row (row.id)}
                                <div>
                                    <dt class="text-xs text-surface-400">{row.label}</dt>
                                    <dd class="tabular-nums text-surface-100">{row.value}</dd>
                                </div>
                            {/each}
                        </dl>
                    </section>
                </div>
            {/if}
        </AsyncSection>
    </FixPageShell>
{/if}
