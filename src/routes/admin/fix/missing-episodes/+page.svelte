<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /admin/fix/missing-episodes — the provider says 24, you have 19.

  ## Measured at page load, not read from a snapshot

  series-sync stores every episode the provider lists; the scanner marks the ones
  with a file. The gap is counted live from those rows (`getEpisodeGapsFromCatalog`).
  This page used to read `series_health_reports`, which nothing had written since
  March, so it said "0 of N series analysed" on every instance.

  ## What is stated next to the findings, deliberately

    - Series with files but no provider episode list cannot show a gap. That is
      "unmeasured", never healthy.
    - Series holding files the provider never matched would list episodes that
      are on disk under another numbering. They are counted and pointed at
      `wrong-match`, because a "missing" table would send the operator to the
      wrong remedy with a confident number attached.
    - The episode lists are as fresh as the last series-sync, so its last run and
      paused state are part of the answer.
-->
<script lang="ts">
    import { Icon, ArrowPath, ExclamationTriangle, CheckCircle } from 'svelte-hero-icons';
    import FixPageShell from '$lib/components/admin/fix/FixPageShell.svelte';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import { findSymptom } from '$lib/components/admin/fix/symptoms.js';
    import {
        EpisodeGapCheckSchema,
        type EpisodeGapCheck,
    } from '$lib/components/admin/fix/episode-gap-check.schema.js';
    import { apiGet } from '$lib/api/client.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    const symptom = findSymptom('missing-episodes');

    let check = $state<EpisodeGapCheck | null>(null);
    let loading = $state(false);
    let loadError = $state<ClassifiedError | null>(null);

    async function load(): Promise<void> {
        loading = true;
        loadError = null;
        const res = await apiGet('/api/admin/fix/episode-gap-check', EpisodeGapCheckSchema, {
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

    /** Series the gap check could actually compare against a provider episode list. */
    const measured = $derived(
        check
            ? Math.max(0, check.seriesWithFiles - check.unmeasuredSeries - check.conflictedSeries)
            : 0,
    );

    function day(iso: string | null): string {
        if (!iso) return '—';
        return new Date(iso).toLocaleDateString();
    }
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
                {m.admin_fix_episodes_refresh()}
            </button>
        </div>

        <AsyncSection {loading} error={loadError} onretry={() => void load()}>
            {#if check}
                <div class="space-y-6">
                    <!-- Coverage first: what these numbers can and cannot speak for. -->
                    <section class="space-y-2 rounded-lg border border-surface-700 p-4">
                        <p class="text-sm text-surface-200">
                            {m.admin_fix_episodes_summary({
                                gaps: check.seriesWithGaps,
                                total: check.seriesWithFiles,
                                missing: check.missingTotal,
                            })}
                        </p>

                        {#if check.unmeasuredSeries > 0}
                            <p class="text-sm text-warning-300">
                                {m.admin_fix_episodes_unmeasured_warn({
                                    count: check.unmeasuredSeries,
                                })}
                            </p>
                        {/if}

                        {#if check.conflictedSeries > 0}
                            <p class="text-sm text-warning-300">
                                {m.admin_fix_episodes_conflicted({
                                    count: check.conflictedSeries,
                                })}
                                <a
                                    href={resolve('/admin/fix/wrong-match')}
                                    class="ml-1 text-primary-300 hover:text-primary-200">
                                    {m.admin_symptom_wrong_match()}
                                </a>
                            </p>
                        {/if}

                        <p class="text-xs text-surface-400">
                            {check.syncLastFiredAt
                                ? m.admin_fix_episodes_lastrun({ when: day(check.syncLastFiredAt) })
                                : check.syncLastRunUnreadable
                                  ? m.admin_fix_episodes_lastrun_unreadable()
                                  : m.admin_fix_episodes_lastrun_never()}
                        </p>

                        {#if check.syncPaused}
                            <p class="flex items-start gap-1.5 text-sm text-warning-300">
                                <Icon src={ExclamationTriangle} class="mt-0.5 h-4 w-4 shrink-0" />
                                <span>{m.admin_fix_episodes_paused_warn()}</span>
                            </p>
                        {/if}
                    </section>

                    <section class="space-y-2">
                        <h2 class="text-sm font-medium text-surface-200">
                            {m.admin_fix_episodes_heading()}
                        </h2>
                        <p class="max-w-3xl text-xs leading-relaxed text-surface-400">
                            {m.admin_fix_episodes_intro()}
                        </p>

                        {#if check.gaps.length === 0 && measured === 0}
                            <!-- Nothing was compared, so "no gaps" would be a claim
                                 without a measurement behind it. -->
                            <p class="text-sm text-surface-300">
                                {check.seriesWithFiles === 0
                                    ? m.admin_fix_episodes_none_noseries()
                                    : m.admin_fix_episodes_none_unmeasured()}
                            </p>
                        {:else if check.gaps.length === 0 && measured < check.seriesWithFiles}
                            <p class="text-sm text-surface-300">
                                {m.admin_fix_episodes_none_partial({
                                    measured,
                                    total: check.seriesWithFiles,
                                })}
                            </p>
                        {:else if check.gaps.length === 0}
                            <div
                                class="flex items-start gap-3 rounded-lg border border-success-700/60 bg-success-900/20 p-4">
                                <Icon
                                    src={CheckCircle}
                                    class="mt-0.5 h-5 w-5 shrink-0 text-success-300" />
                                <div class="space-y-1">
                                    <p class="text-sm font-medium text-surface-100">
                                        {m.admin_fix_episodes_none_title()}
                                    </p>
                                    <p class="text-sm text-surface-300">
                                        {m.admin_fix_episodes_none_body()}
                                    </p>
                                </div>
                            </div>
                        {:else}
                            <div class="overflow-x-auto">
                                <table class="w-full min-w-[28rem] text-sm">
                                    <thead>
                                        <tr class="text-left text-xs text-surface-400">
                                            <th class="py-1 pr-3 font-normal">
                                                {m.admin_fix_episodes_col_series()}
                                            </th>
                                            <th class="py-1 pr-3 text-right font-normal">
                                                {m.admin_fix_episodes_col_local()}
                                            </th>
                                            <th class="py-1 pr-3 text-right font-normal">
                                                {m.admin_fix_episodes_col_missing()}
                                            </th>
                                            <th class="py-1 text-right font-normal">
                                                {m.admin_fix_episodes_col_seasons()}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y divide-surface-800">
                                        {#each check.gaps as gap (gap.seriesId)}
                                            <tr>
                                                <td class="py-1.5 pr-3">
                                                    <a
                                                        href={resolve(
                                                            `/admin/library/media/${encodeURIComponent(gap.seriesId)}`,
                                                        )}
                                                        class="text-surface-100 hover:text-primary-300">
                                                        {gap.title}
                                                    </a>
                                                </td>
                                                <td
                                                    class="py-1.5 pr-3 text-right tabular-nums text-surface-200">
                                                    {gap.held}
                                                </td>
                                                <td
                                                    class="py-1.5 pr-3 text-right tabular-nums font-medium text-warning-300">
                                                    {gap.missing}
                                                </td>
                                                <td
                                                    class="py-1.5 text-right tabular-nums text-xs text-surface-500">
                                                    {gap.seasonsAffected}
                                                </td>
                                            </tr>
                                        {/each}
                                    </tbody>
                                </table>
                            </div>

                            {#if check.gapsTruncated}
                                <p class="text-xs text-surface-400">
                                    {m.admin_fix_episodes_truncated({ count: check.gaps.length })}
                                </p>
                            {/if}
                        {/if}
                    </section>
                </div>
            {/if}
        </AsyncSection>
    </FixPageShell>
{/if}
