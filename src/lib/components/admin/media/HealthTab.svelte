<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import HelpPopover from '$lib/components/admin/HelpPopover.svelte';
    import * as m from '$lib/paraglide/messages';
    import {
        Icon,
        ArrowPath,
        CheckCircle,
        InformationCircle,
        XCircle,
        QuestionMarkCircle,
    } from 'svelte-hero-icons';
    import { toasts } from '$lib/stores/toast.store';
    import { getSeriesHealth, getReconciliationPreview, applyReconciliation } from '$lib/api/admin';
    import type { ReconciliationProposal } from '$lib/schemas/api-admin-responses.js';
    import { reconciliationReasonLabel } from './reconciliation-reason.js';
    import {
        RECONCILE_AUTO_APPLY_CONFIDENCE,
        RECONCILE_PREVIEW_CONFIDENCE,
    } from '$lib/shared/reconcile-thresholds.js';
    import { SvelteSet } from 'svelte/reactivity';

    interface Props {
        seriesId: string;
    }

    let { seriesId }: Props = $props();

    interface UnlinkedEpisode {
        orderSeasonNumber: number | null;
        orderEpisodeNumber: number;
        episodeTitle: string | null;
    }

    interface IdentityHealthReport {
        status: 'healthy' | 'notice' | 'warning' | 'mismatch' | 'unknown';
        orderingType: string;
        orderingGroupId: string | null;
        total: number;
        linked: number;
        unlinked: number;
        linkRatio: number;
        unlinkedEpisodes: UnlinkedEpisode[];
    }

    interface ProviderComparison {
        status: 'healthy' | 'notice' | 'warning' | 'mismatch' | 'unknown';
        seasonCountLocal: number;
        seasonCountProvider: number;
        episodeCountLocal: number;
        episodeCountProvider: number;
    }

    let report = $state<IdentityHealthReport | null>(null);
    let providerComparison = $state<ProviderComparison | null>(null);
    let analyzing = $state(false);
    let noOrdering = $state(false);
    let loading = $state(true);

    $effect(() => {
        const _id = seriesId;
        void loadCachedReport();
    });

    async function loadCachedReport(): Promise<void> {
        loading = true;
        try {
            const { data } = await getSeriesHealth(seriesId);
            if (data) {
                // The report is live now; it has no ordering block when the series
                // uses the standard ordering.
                noOrdering = !data.report?.orderingHealth;
                report = null;
                providerComparison = null;
                if (data.report) {
                    const r = data.report;
                    if (r.seasonCountLocal != null && r.seasonCountProvider != null) {
                        providerComparison = {
                            status: r.status as ProviderComparison['status'],
                            seasonCountLocal: r.seasonCountLocal as number,
                            seasonCountProvider: r.seasonCountProvider as number,
                            episodeCountLocal: r.episodeCountLocal as number,
                            episodeCountProvider: r.episodeCountProvider as number,
                        };
                    }

                    if (r.orderingHealth) {
                        const oh = r.orderingHealth as Record<string, unknown>;
                        const linkRatio = oh.linkRatio as number;
                        report = {
                            status:
                                linkRatio >= 0.95
                                    ? 'healthy'
                                    : linkRatio >= 0.7
                                      ? 'warning'
                                      : (oh.total as number) > 0
                                        ? 'mismatch'
                                        : 'unknown',
                            orderingType: (oh.orderingType as string) ?? 'standard',
                            orderingGroupId: (oh.groupId as string) ?? null,
                            total: oh.total as number,
                            linked: oh.linked as number,
                            unlinked: oh.unlinked as number,
                            linkRatio,
                            unlinkedEpisodes: [],
                        };
                    }
                }
            }
        } catch (e) {
            console.warn('[HealthTab] Failed to load health report', e);
        } finally {
            loading = false;
        }
    }

    const statusColors = {
        healthy: {
            badge: 'bg-green-400/10 text-green-400 border border-green-400/30',
            bar: 'bg-green-400',
            label: m.media_health_status_healthy(),
        },
        notice: {
            badge: 'bg-blue-400/10 text-blue-400 border border-blue-400/30',
            bar: 'bg-blue-400',
            label: m.media_health_status_notice(),
        },
        warning: {
            badge: 'bg-yellow-400/10 text-yellow-400 border border-yellow-400/30',
            bar: 'bg-yellow-400',
            label: m.media_health_status_warning(),
        },
        mismatch: {
            badge: 'bg-red-400/10 text-red-400 border border-red-400/30',
            bar: 'bg-red-400',
            label: m.media_health_status_warning(),
        },
        unknown: {
            badge: 'bg-surface-400/10 text-surface-400 border border-surface-400/30',
            bar: 'bg-surface-400',
            label: m.media_health_status_unknown(),
        },
    } as const;

    function formatEpisodeLabel(ep: UnlinkedEpisode): string {
        const season = ep.orderSeasonNumber != null ? `S${ep.orderSeasonNumber}` : '';
        const episode = `E${ep.orderEpisodeNumber}`;
        return season ? `${season}${episode}` : episode;
    }

    async function runAnalysis(): Promise<void> {
        analyzing = true;
        noOrdering = false;
        try {
            const res = await fetch(`/api/admin/media/${seriesId}/health/analyze`, {
                method: 'POST',
            });
            if (!res.ok) {
                toasts.error(m.media_health_analysis_failed());
                return;
            }
            const analyzed = (await res.json()) as { report: IdentityHealthReport | null };
            await loadCachedReport();
            // Only the analysis lists the unlinked episodes; the GET carries counts.
            if (analyzed.report) report = analyzed.report;
            toasts.success(m.media_health_analysis_complete());
        } catch {
            toasts.error(m.media_health_analysis_failed());
        } finally {
            analyzing = false;
        }
    }

    // -------------------------------------------------------------------------
    // Episode title reconciliation
    // -------------------------------------------------------------------------

    let reconcileProposals = $state<ReconciliationProposal[]>([]);
    let reconcileLoading = $state(false);
    let reconcileError = $state<string | null>(null);
    let reconcileApplying = $state(false);
    let selectedEpisodeIds = new SvelteSet<string>();

    const matchedProposals = $derived(
        reconcileProposals.filter((p) => p.changed && p.reason === 'matched'),
    );
    // What "Apply high-confidence" will actually apply: the preview lists every
    // match from RECONCILE_PREVIEW_CONFIDENCE, the bulk button only the top tier.
    const highConfidenceProposals = $derived(
        matchedProposals.filter((p) => p.confidence >= RECONCILE_AUTO_APPLY_CONFIDENCE),
    );

    // Same rule as the server's needsReviewCount: identity-bound (a prior
    // confident match) and manually-locked rows are frozen on purpose and need
    // nobody's attention.
    const FROZEN_REASONS: ReadonlySet<ReconciliationProposal['reason']> = new Set([
        'identity-bound',
        'manually-locked',
    ]);
    const needsReviewProposals = $derived(
        reconcileProposals.filter((p) => p.reason !== 'matched' && !FROZEN_REASONS.has(p.reason)),
    );

    const hasSelection = $derived(selectedEpisodeIds.size > 0);

    // Reason copy is `reconciliationReasonLabel` in `reconciliation-reason.ts`,
    // an exhaustive switch. It was a record keyed on the proposal reason here,
    // checked by nothing — tsgo skips `.svelte`, and svelte-check-native does not
    // flag a broken key in a component-local record — so a reason added to
    // `ReconciliationProposalSchema` would have rendered `undefined` in the
    // needs-review list an operator reads before applying a batch of rewrites.

    function formatSE(p: ReconciliationProposal): string {
        const s = p.seasonNumber != null ? `S${p.seasonNumber}` : '';
        const e = p.episodeNumber != null ? `E${p.episodeNumber}` : '';
        return s || e ? `${s}${e}` : '—';
    }

    function toggleEpisode(id: string): void {
        if (selectedEpisodeIds.has(id)) {
            selectedEpisodeIds.delete(id);
        } else {
            selectedEpisodeIds.add(id);
        }
    }

    async function loadReconciliationPreview(): Promise<void> {
        reconcileLoading = true;
        reconcileError = null;
        selectedEpisodeIds.clear();
        try {
            const { data, error } = await getReconciliationPreview(seriesId);
            if (error || !data) {
                reconcileError = m.media_health_preview_load_failed();
                return;
            }
            reconcileProposals = data.proposals;
        } catch {
            reconcileError = m.media_health_preview_load_failed();
        } finally {
            reconcileLoading = false;
        }
    }

    async function applyHighConfidence(): Promise<void> {
        // Not while a preview reload is replacing the list the operator reviewed.
        if (reconcileApplying || reconcileLoading) return;
        reconcileApplying = true;
        try {
            const { data, error } = await applyReconciliation(seriesId, {
                minConfidence: RECONCILE_AUTO_APPLY_CONFIDENCE,
            });
            if (error || !data) {
                toasts.error(m.media_health_apply_fixes_failed());
                return;
            }
            // The server re-previews and skips locked rows, so it can apply
            // nothing; saying "applied" then was false.
            if (data.updatedTitles === 0 && data.appliedExternalIds === 0) {
                toasts.info(m.media_health_nothing_applied());
            } else {
                toasts.success(m.media_health_high_confidence_applied());
            }
            await loadReconciliationPreview();
        } catch {
            toasts.error(m.media_health_apply_fixes_failed());
        } finally {
            reconcileApplying = false;
        }
    }

    async function applySelected(): Promise<void> {
        if (selectedEpisodeIds.size === 0 || reconcileApplying || reconcileLoading) return;
        reconcileApplying = true;
        try {
            const { data, error } = await applyReconciliation(seriesId, {
                minConfidence: RECONCILE_PREVIEW_CONFIDENCE,
                episodeIds: Array.from(selectedEpisodeIds),
            });
            if (error || !data) {
                toasts.error(m.media_health_apply_selected_failed());
                return;
            }
            if (data.updatedTitles === 0 && data.appliedExternalIds === 0) {
                toasts.info(m.media_health_nothing_applied());
            } else {
                toasts.success(m.media_health_selected_applied());
            }
            await loadReconciliationPreview();
        } catch {
            toasts.error(m.media_health_apply_selected_failed());
        } finally {
            reconcileApplying = false;
        }
    }

    const hasNonStandardOrdering = $derived(
        report != null &&
            report.orderingType != null &&
            report.orderingType !== 'standard' &&
            report.orderingType !== '',
    );
</script>

<div class="space-y-6">
    <div class="flex items-center justify-between">
        <div>
            <h3 class="text-lg font-semibold text-white">
                {m.media_health_ordering_check_title()}
            </h3>
            <p class="text-sm text-surface-400 mt-1">
                {m.media_plain_coverage_action()}
            </p>
            <HelpPopover variant="inline"
                ><p>{m.media_health_ordering_check_description()}</p>
                <p>{m.media_health_provider_comparison_note()}</p></HelpPopover>
        </div>
        <button
            onclick={runAnalysis}
            disabled={analyzing}
            class="btn variant-filled-primary text-sm px-4 py-2 inline-flex items-center gap-2">
            {#if analyzing}
                <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
            {/if}
            {analyzing ? m.media_health_analyzing() : m.media_health_run_analysis()}
        </button>
    </div>

    {#if noOrdering}
        <div
            class="text-center py-12 text-surface-500 bg-surface-800/40 rounded-lg border border-surface-700/50">
            <Icon src={QuestionMarkCircle} class="w-10 h-10 mx-auto mb-3 text-surface-600" />
            <p class="text-sm">{m.media_health_no_ordering_active()}</p>
            <p class="text-xs mt-1 text-surface-600">
                {m.media_health_no_ordering_hint()}
            </p>
        </div>
    {:else if loading}
        <div
            class="text-center py-12 text-surface-500 bg-surface-800/40 rounded-lg border border-surface-700/50">
            <Icon src={ArrowPath} class="w-10 h-10 mx-auto mb-3 text-surface-600 animate-spin" />
            <p class="text-sm">{m.media_health_loading_report()}</p>
        </div>
    {:else if !report}
        <div
            class="text-center py-12 text-surface-500 bg-surface-800/40 rounded-lg border border-surface-700/50">
            <Icon src={QuestionMarkCircle} class="w-10 h-10 mx-auto mb-3 text-surface-600" />
            <p class="text-sm">
                {m.media_health_no_report_available()}
            </p>
        </div>
    {:else}
        {@const colors = statusColors[report.status]}

        <!-- Status summary -->
        <div class="rounded-lg bg-surface-800/60 border border-surface-700/50 p-4 space-y-4">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                    <span class="text-xs font-semibold px-2.5 py-1 rounded-full {colors.badge}">
                        {report.status === 'healthy' && report.linked < report.total
                            ? m.media_health_status_warning()
                            : colors.label}
                    </span>
                    <span class="text-sm text-surface-400">
                        {m.media_health_episodes_linked_summary({
                            linked: report.linked,
                            total: report.total,
                        })}
                    </span>
                </div>
                <span
                    class="text-lg font-mono font-semibold {report.status === 'healthy'
                        ? 'text-green-400'
                        : report.status === 'notice'
                          ? 'text-blue-400'
                          : report.status === 'warning'
                            ? 'text-yellow-400'
                            : report.status === 'mismatch'
                              ? 'text-red-400'
                              : 'text-surface-400'}">
                    {(report.linkRatio * 100).toFixed(0)}%
                </span>
            </div>

            <!-- Progress bar -->
            <div class="w-full bg-surface-700 rounded-full h-2">
                <div
                    class="h-2 rounded-full transition-all {colors.bar}"
                    style="width: {report.linkRatio * 100}%">
                </div>
            </div>

            <!-- Counts row -->
            <div class="flex gap-6 text-sm">
                <div class="flex items-center gap-1.5">
                    <Icon src={CheckCircle} class="w-4 h-4 text-green-400 shrink-0" />
                    <span class="text-surface-300"
                        >{m.media_health_count_linked({ count: report.linked })}</span>
                </div>
                <div class="flex items-center gap-1.5">
                    <Icon src={XCircle} class="w-4 h-4 text-red-400 shrink-0" />
                    <span class="text-surface-300"
                        >{m.media_health_count_unlinked({ count: report.unlinked })}</span>
                </div>
                <div class="text-surface-500 text-xs self-center">
                    {m.media_health_ordering_label({ orderingType: report.orderingType })}
                    {#if report.orderingGroupId}
                        {m.media_health_ordering_group({ groupId: report.orderingGroupId })}
                    {/if}
                </div>
            </div>

            <p class="text-xs text-surface-500">
                {m.media_health_linked_explanation()}
            </p>
        </div>

        <!-- Unlinked episodes list -->
        {#if report.unlinkedEpisodes.length > 0}
            <div class="space-y-2">
                <h4 class="text-sm font-medium text-surface-300 uppercase tracking-wide">
                    {m.media_health_unlinked_episodes_heading({
                        count: report.unlinkedEpisodes.length,
                    })}
                </h4>
                <div class="rounded-lg border border-surface-700/50 overflow-hidden">
                    <table class="w-full text-sm">
                        <thead>
                            <tr
                                class="bg-surface-800/80 text-surface-400 text-xs uppercase tracking-wide">
                                <th class="px-3 py-2 text-left">{m.player_subtitle_position()}</th>
                                <th class="px-3 py-2 text-left">{m.media_health_col_title()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each report.unlinkedEpisodes as ep, epIdx (formatEpisodeLabel(ep) + '-' + epIdx)}
                                <tr class="border-t border-surface-700/30 bg-red-900/5">
                                    <td
                                        class="px-3 py-2 font-mono text-surface-300 whitespace-nowrap">
                                        {formatEpisodeLabel(ep)}
                                    </td>
                                    <td class="px-3 py-2 text-surface-400 truncate max-w-xs">
                                        {ep.episodeTitle ?? '—'}
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
                <p class="text-xs text-surface-500">
                    {m.media_health_reapply_ordering_hint()}
                </p>
            </div>
        {:else if report.status === 'healthy'}
            <div
                class="flex items-center gap-2 rounded-lg bg-green-900/20 border border-green-500/30 p-3">
                <Icon src={CheckCircle} class="w-5 h-5 text-green-400 shrink-0" />
                <p class="text-sm text-green-300">
                    {m.media_health_all_entries_linked()}
                </p>
            </div>
        {/if}
    {/if}

    {#if providerComparison && (providerComparison.seasonCountLocal !== providerComparison.seasonCountProvider || providerComparison.episodeCountLocal !== providerComparison.episodeCountProvider)}
        <div
            class="rounded-lg border p-4 space-y-3
            {providerComparison.status === 'notice'
                ? 'bg-blue-900/10 border-blue-500/20'
                : providerComparison.status === 'warning'
                  ? 'bg-yellow-900/10 border-yellow-500/20'
                  : providerComparison.status === 'mismatch'
                    ? 'bg-red-900/10 border-red-500/20'
                    : 'bg-surface-800/40 border-surface-700/30'}">
            <div class="flex items-center gap-2">
                <Icon
                    src={InformationCircle}
                    class="w-5 h-5 shrink-0
                    {providerComparison.status === 'notice'
                        ? 'text-blue-400'
                        : providerComparison.status === 'warning'
                          ? 'text-yellow-400'
                          : providerComparison.status === 'mismatch'
                            ? 'text-red-400'
                            : 'text-surface-400'}" />
                <h4 class="text-sm font-medium text-white">
                    {m.media_health_provider_comparison_title()}
                </h4>
            </div>
            <div class="grid grid-cols-2 gap-4 text-sm">
                {#if providerComparison.seasonCountLocal !== providerComparison.seasonCountProvider}
                    <div class="space-y-1">
                        <span class="text-xs text-surface-500 uppercase tracking-wide"
                            >{m.seasons()}</span>
                        <div class="text-surface-300">
                            {m.media_health_local_vs_provider({
                                local: providerComparison.seasonCountLocal,
                                provider: providerComparison.seasonCountProvider,
                            })}
                        </div>
                    </div>
                {/if}
                {#if providerComparison.episodeCountLocal !== providerComparison.episodeCountProvider}
                    <div class="space-y-1">
                        <span class="text-xs text-surface-500 uppercase tracking-wide"
                            >{m.episodes()}</span>
                        <div class="text-surface-300">
                            {m.media_health_local_vs_provider({
                                local: providerComparison.episodeCountLocal,
                                provider: providerComparison.episodeCountProvider,
                            })}
                        </div>
                    </div>
                {/if}
            </div>
            <p class="text-xs text-surface-500">
                {m.media_health_provider_comparison_note()}
            </p>
        </div>
    {/if}

    <!-- ====================================================================
         Episode Title Reconciliation Panel
    ===================================================================== -->
    <div class="space-y-4">
        <div class="flex items-center justify-between">
            <div>
                <h3 class="text-lg font-semibold text-white">
                    {m.media_health_fix_titles_title()}
                </h3>
                <p class="text-sm text-surface-400 mt-1">
                    {m.media_health_fix_titles_description()}
                </p>
            </div>
            <button
                onclick={loadReconciliationPreview}
                disabled={reconcileLoading}
                class="btn variant-filled-primary text-sm px-4 py-2 inline-flex items-center gap-2">
                {#if reconcileLoading}
                    <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                {/if}
                {reconcileLoading ? m.media_health_analyzing() : m.media_health_analyze_titles()}
            </button>
        </div>

        {#if reconcileError}
            <div
                class="flex items-center gap-2 rounded-lg bg-red-900/20 border border-red-500/30 p-3">
                <Icon src={XCircle} class="w-5 h-5 text-red-400 shrink-0" />
                <p class="text-sm text-red-300">{reconcileError}</p>
            </div>
        {:else if reconcileProposals.length > 0}
            <!-- Matched proposals table -->
            {#if matchedProposals.length > 0}
                <div class="space-y-3">
                    <h4 class="text-sm font-medium text-surface-300 uppercase tracking-wide">
                        {m.media_health_proposed_fixes_heading({ count: matchedProposals.length })}
                    </h4>

                    {#if hasNonStandardOrdering}
                        <div
                            class="flex items-start gap-2 rounded-lg bg-yellow-900/10 border border-yellow-500/20 px-3 py-2">
                            <Icon
                                src={InformationCircle}
                                class="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
                            <p class="text-xs text-yellow-300">
                                {m.media_health_custom_ordering_note()}
                            </p>
                        </div>
                    {/if}

                    <div class="rounded-lg border border-surface-700/50 overflow-hidden">
                        <table class="w-full text-sm">
                            <thead>
                                <tr
                                    class="bg-surface-800/80 text-surface-400 text-xs uppercase tracking-wide">
                                    <th class="px-3 py-2 text-left w-8">
                                        <span class="sr-only">{m.media_health_col_select()}</span>
                                    </th>
                                    <th class="px-3 py-2 text-left whitespace-nowrap"
                                        >{m.media_health_col_se()}</th>
                                    <th class="px-3 py-2 text-left"
                                        >{m.media_health_col_current_title()}</th>
                                    <th class="px-3 py-2 text-left w-4"></th>
                                    <th class="px-3 py-2 text-left"
                                        >{m.media_health_col_proposed_title()}</th>
                                    <th class="px-3 py-2 text-right whitespace-nowrap"
                                        >{m.media_health_col_confidence()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {#each matchedProposals as proposal, proposalIdx (proposal.episodeId + '-' + proposalIdx)}
                                    <tr
                                        class="border-t border-surface-700/30 hover:bg-surface-800/40">
                                        <td class="px-3 py-2">
                                            <input
                                                type="checkbox"
                                                checked={selectedEpisodeIds.has(proposal.episodeId)}
                                                onchange={() => toggleEpisode(proposal.episodeId)}
                                                class="rounded border-surface-600 bg-surface-700 text-primary-500 focus:ring-primary-500" />
                                        </td>
                                        <td
                                            class="px-3 py-2 font-mono text-surface-300 whitespace-nowrap">
                                            {formatSE(proposal)}
                                        </td>
                                        <td class="px-3 py-2 text-surface-400 truncate max-w-xs">
                                            {proposal.currentTitle ?? '—'}
                                        </td>
                                        <td class="px-2 py-2 text-surface-600 text-xs"> → </td>
                                        <td class="px-3 py-2 text-surface-200 truncate max-w-xs">
                                            {proposal.proposedTitle ?? '—'}
                                        </td>
                                        <td
                                            class="px-3 py-2 text-right font-mono text-xs
                                            {proposal.confidence >= RECONCILE_AUTO_APPLY_CONFIDENCE
                                                ? 'text-green-400'
                                                : proposal.confidence >= 0.7
                                                  ? 'text-yellow-400'
                                                  : 'text-red-400'}">
                                            {(proposal.confidence * 100).toFixed(0)}%
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>

                    <div class="flex items-center gap-3 flex-wrap">
                        <button
                            onclick={applyHighConfidence}
                            disabled={reconcileApplying || highConfidenceProposals.length === 0}
                            class="btn variant-filled-success text-sm px-4 py-2 inline-flex items-center gap-2">
                            {#if reconcileApplying}
                                <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                            {/if}
                            {m.media_health_apply_high_confidence({
                                count: highConfidenceProposals.length,
                            })}
                        </button>
                        <button
                            onclick={applySelected}
                            disabled={reconcileApplying || !hasSelection}
                            class="btn variant-soft-primary text-sm px-4 py-2 inline-flex items-center gap-2 disabled:opacity-40">
                            {m.media_health_apply_selected({ count: selectedEpisodeIds.size })}
                        </button>
                    </div>
                </div>
            {:else}
                <div
                    class="flex items-center gap-2 rounded-lg bg-green-900/20 border border-green-500/30 p-3">
                    <Icon src={CheckCircle} class="w-5 h-5 text-green-400 shrink-0" />
                    <p class="text-sm text-green-300">
                        {m.media_health_no_fixes_needed()}
                    </p>
                </div>
            {/if}

            <!-- Needs review subsection -->
            {#if needsReviewProposals.length > 0}
                <div class="space-y-2 mt-4">
                    <h4 class="text-sm font-medium text-surface-300 uppercase tracking-wide">
                        {m.media_health_needs_review_heading({
                            count: needsReviewProposals.length,
                        })}
                    </h4>
                    <div class="rounded-lg border border-surface-700/50 overflow-hidden">
                        <table class="w-full text-sm">
                            <thead>
                                <tr
                                    class="bg-surface-800/80 text-surface-400 text-xs uppercase tracking-wide">
                                    <th class="px-3 py-2 text-left whitespace-nowrap"
                                        >{m.media_health_col_se()}</th>
                                    <th class="px-3 py-2 text-left"
                                        >{m.media_health_col_current_title()}</th>
                                    <th class="px-3 py-2 text-left"
                                        >{m.media_health_col_reason()}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {#each needsReviewProposals as proposal, proposalIdx (proposal.episodeId + '-' + proposalIdx)}
                                    <tr class="border-t border-surface-700/30 bg-surface-800/20">
                                        <td
                                            class="px-3 py-2 font-mono text-surface-300 whitespace-nowrap">
                                            {formatSE(proposal)}
                                        </td>
                                        <td class="px-3 py-2 text-surface-400 truncate max-w-xs">
                                            {proposal.currentTitle ?? '—'}
                                        </td>
                                        <td class="px-3 py-2 text-surface-500 text-xs">
                                            {reconciliationReasonLabel(proposal.reason)}
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                </div>
            {/if}
        {/if}
    </div>
</div>
