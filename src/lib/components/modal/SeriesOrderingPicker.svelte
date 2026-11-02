<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { ImageSet } from '$lib/schemas/api-image-descriptor';
    import { onMount } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { Icon, ChevronDown, Check, XMark, ArrowPath, Eye } from 'svelte-hero-icons';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';
    import { modals } from '$lib/stores/modal.store';
    import OrderingPreviewModal from './OrderingPreviewModal.svelte';
    import { groupOrderingsByType } from './ordering-group-type';
    import {
        getSeriesOrdering,
        setSeriesOrdering,
        resetSeriesOrdering,
        applySeriesOrdering,
        syncSeriesOrderings,
    } from '$lib/api/content';

    interface OrderingInfo {
        orderingType: string;
        orderingSource: string;
        provider: string | null;
        groupId: string | null;
    }

    interface AvailableOrdering {
        type: string;
        provider: string;
        groupId: string;
        name: string;
        description?: string;
        episodeCount: number;
        groupCount: number;
        providerType?: number;
    }

    interface PreviewGroup {
        displayLabel: string;
        episodeCount: number;
        originalRange: string;
        displayRange: string;
        images: ImageSet;
    }

    interface PreviewEpisode {
        originalSeason: number;
        originalEpisode: number;
        name: string;
        newGroupIndex: number;
        newPositionInGroup: number;
        absoluteNumber: number | null;
    }

    interface PreviewData {
        name: string;
        type: string;
        providerType?: number;
        seasonTotals?: Array<{ seasonNumber: number; episodeCount: number }>;
        totalEpisodes: number;
        groups: PreviewGroup[];
        episodes: PreviewEpisode[];
    }

    interface GroupScoreInfo {
        groupId: string;
        score: number;
        breakdown: string;
    }

    interface Props {
        seriesId: string;
        isAdmin: boolean;
        groupScores?: GroupScoreInfo[];
        onapply?: () => void;
    }

    let { seriesId, isAdmin, groupScores = [], onapply }: Props = $props();

    let bestGroup = $derived(
        groupScores.reduce(
            (best, g) => (g.score > (best?.score ?? 0) ? g : best),
            null as GroupScoreInfo | null,
        ),
    );

    let current = $state<OrderingInfo | null>(null);
    let available = $state<AvailableOrdering[]>([]);
    let loaded = $state(false);
    let editing = $state(false);
    let saving = $state(false);
    let applyingGroupId = $state<string | null>(null);
    let confirmReset = $state(false);
    const loadingPreviews = new SvelteSet<string>();
    let previews = $state<Record<string, PreviewData>>({});

    let isStandardWithNone = $derived(
        loaded && current?.orderingType === 'standard' && available.length === 0,
    );

    let showAdminUI = $derived(
        loaded && isAdmin && (current?.orderingType !== 'standard' || available.length > 0),
    );

    let showAdminEmpty = $derived(loaded && isAdmin && isStandardWithNone);

    let showReadOnlyBadge = $derived(
        loaded && !isAdmin && current !== null && current.orderingType !== 'standard',
    );

    let fetching = $state(false);

    const listId = $props.id();

    /** Providers that offer the listed groups, for the section heading (e.g. "TMDB"). */
    let groupProviders = $derived(
        [...new Set(available.map((a) => a.provider.toUpperCase()))].join(', '),
    );

    let typeSections = $derived(groupOrderingsByType(available));

    onMount(async () => {
        try {
            const { data } = await getSeriesOrdering(seriesId);
            if (data) {
                current = data.current;
                available = data.available;
            }
        } catch {
            /* expected: ordering data unavailable — picker shows default only */
        } finally {
            loaded = true;
        }
    });

    function getCurrentLabel(): string {
        if (!current || current.orderingType === 'standard') {
            return 'Standard (default)';
        }
        const match = available.find(
            (a) =>
                a.type === current?.orderingType &&
                a.provider === current?.provider &&
                a.groupId === current?.groupId,
        );
        return match?.name ?? current.orderingType;
    }

    async function selectOrdering(ordering: AvailableOrdering): Promise<void> {
        if (saving) return;
        saving = true;
        applyingGroupId = ordering.groupId;
        try {
            const { data: setData, error: setError } = await setSeriesOrdering(seriesId, {
                orderingType: ordering.type,
                provider: ordering.provider,
                groupId: ordering.groupId,
            });
            if (!setError && setData) {
                current = setData;
                editing = false;

                // Link episodes to the ordering entries
                const { data: applyData, error: applyError } = await applySeriesOrdering(seriesId, {
                    provider: ordering.provider,
                    groupId: ordering.groupId,
                });
                if (!applyError && applyData) {
                    const total = applyData.applied + applyData.skipped;
                    const linkedMsg =
                        applyData.skipped === 0
                            ? `all ${applyData.applied} episodes linked`
                            : `${applyData.applied}/${total} episodes linked (${applyData.skipped} unlinked)`;
                    toasts.success(`Ordering applied: ${linkedMsg}`);
                    if (applyData.combined > 0) {
                        toasts.info(
                            `This ordering includes ${applyData.combined} combined episode${applyData.combined === 1 ? '' : 's'} (e.g., E1-E2)`,
                        );
                    }
                    onapply?.();
                } else {
                    toasts.error('Ordering saved but episodes could not be linked');
                    onapply?.();
                }
            } else {
                toasts.error(m.toast_ordering_update_failed());
            }
        } catch {
            toasts.error(m.toast_ordering_update_failed());
        } finally {
            saving = false;
            applyingGroupId = null;
        }
    }

    async function resetToStandard(): Promise<void> {
        if (saving) return;
        if (current?.orderingType !== 'standard' && !confirmReset) {
            confirmReset = true;
            return;
        }
        confirmReset = false;
        saving = true;
        try {
            const { data, error } = await resetSeriesOrdering(seriesId);
            if (!error && data) {
                current = {
                    orderingType: 'standard',
                    orderingSource: 'default',
                    provider: null,
                    groupId: null,
                };
                editing = false;
                toasts.success(m.toast_ordering_reset_success());
                onapply?.();
            } else {
                toasts.error(m.toast_ordering_reset_failed());
            }
        } catch {
            toasts.error(m.toast_ordering_reset_failed());
        } finally {
            saving = false;
        }
    }

    function isCurrentOrdering(ordering: AvailableOrdering): boolean {
        return (
            current?.orderingType === ordering.type &&
            current?.provider === ordering.provider &&
            current?.groupId === ordering.groupId
        );
    }

    async function fetchOrderings(): Promise<void> {
        fetching = true;
        try {
            const { error: syncError } = await syncSeriesOrderings(seriesId);
            if (syncError) {
                toasts.error(m.toast_orderings_fetch_failed());
                return;
            }

            // Reload available orderings
            const { data } = await getSeriesOrdering(seriesId);
            if (data) {
                current = data.current;
                available = data.available;
                if (data.available.length > 0) {
                    toasts.success(`Found ${data.available.length} alternative ordering(s)`);
                } else {
                    toasts.info('No alternative orderings available for this series');
                }
            }
        } catch {
            toasts.error(m.toast_orderings_fetch_failed_generic());
        } finally {
            fetching = false;
        }
    }

    async function openPreview(ordering: AvailableOrdering): Promise<void> {
        if (loadingPreviews.has(ordering.groupId)) return;

        // Use cached data if available
        if (previews[ordering.groupId]) {
            modals.open(
                OrderingPreviewModal,
                previews[ordering.groupId] as unknown as Record<string, unknown>,
            );
            return;
        }

        loadingPreviews.add(ordering.groupId);
        try {
            const res = await fetch(
                `/api/series/${seriesId}/ordering/preview?provider=${encodeURIComponent(ordering.provider)}&groupId=${encodeURIComponent(ordering.groupId)}`,
            );
            if (res.ok) {
                const data = (await res.json()) as PreviewData;
                previews = { ...previews, [ordering.groupId]: data };
                modals.open(OrderingPreviewModal, data as unknown as Record<string, unknown>);
            } else {
                toasts.error(m.toast_preview_load_failed());
            }
        } catch {
            toasts.error(m.toast_preview_load_failed());
        } finally {
            loadingPreviews.delete(ordering.groupId);
        }
    }
</script>

{#if showAdminUI}
    <div class="ordering-section mt-3">
        <button
            type="button"
            class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-left transition-colors border
                bg-surface-800/60 hover:bg-surface-700/60 focus-visible:outline-2 focus-visible:outline-primary-400
                disabled:opacity-60 {editing
                ? 'border-primary-500/50'
                : 'border-surface-600/60 hover:border-surface-500/70'}"
            onclick={() => (editing = !editing)}
            aria-expanded={editing}
            aria-controls={listId}
            aria-label={m.modal_ordering_current_aria({ current: getCurrentLabel() })}
            disabled={saving}>
            <span class="text-surface-400 font-medium shrink-0">{m.modal_episode_ordering()}</span>
            <span class="flex-1 min-w-0 truncate text-surface-100">{getCurrentLabel()}</span>
            <Icon
                src={ChevronDown}
                class="w-4 h-4 shrink-0 text-surface-400 transition-transform {editing
                    ? 'rotate-180'
                    : ''}" />
        </button>

        {#if editing}
            <div
                id={listId}
                class="mt-2 bg-surface-800/60 rounded-lg p-3 space-y-1 border border-surface-700/50">
                <!-- Standard (default) option -->
                {#if confirmReset}
                    <div
                        class="flex items-center gap-2 px-3 py-2 rounded text-sm bg-yellow-400/10 border border-yellow-400/20">
                        <span class="text-yellow-300 flex-1"
                            >{m.modal_remove_ordering_confirm()}</span>
                        <button
                            class="text-xs px-2 py-1 rounded bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30 transition-colors"
                            onclick={resetToStandard}
                            disabled={saving}>
                            Confirm
                        </button>
                        <button
                            class="text-xs px-2 py-1 rounded text-surface-400 hover:text-surface-200 transition-colors"
                            onclick={() => (confirmReset = false)}>
                            Cancel
                        </button>
                    </div>
                {:else}
                    <button
                        class="w-full flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors text-left
                            {current?.orderingType === 'standard'
                            ? 'bg-primary-600/30 text-primary-200'
                            : 'text-surface-300 hover:bg-surface-700/60 hover:text-surface-100'}"
                        onclick={resetToStandard}
                        disabled={saving || current?.orderingType === 'standard'}>
                        {#if current?.orderingType === 'standard'}
                            <Icon src={Check} class="w-4 h-4 shrink-0 text-primary-400" />
                        {:else}
                            <span class="w-4 h-4 shrink-0"></span>
                        {/if}
                        <span class="flex-1 min-w-0">
                            <span class="block">{m.modal_standard_default()}</span>
                            <span class="block text-xs text-surface-500 mt-0.5"
                                >{m.modal_standard_default_hint()}</span>
                        </span>
                    </button>
                {/if}

                <!-- Provider episode groups, set apart from the default -->
                {#if available.length > 0}
                    <div
                        class="pt-3 mt-2 px-3 pb-1 border-t border-surface-700/50 text-xs font-medium uppercase tracking-wide text-surface-500">
                        {m.modal_ordering_provider_groups({ provider: groupProviders })}
                    </div>
                {/if}
                {#each typeSections as section (section.key)}
                    <div class="px-3 pt-2 pb-0.5 text-xs text-surface-400">{section.label}</div>
                    {#each section.items as ordering (ordering.groupId + ordering.type)}
                        {@const gs = groupScores.find((s) => s.groupId === ordering.groupId)}
                        {@const empty = ordering.episodeCount === 0}
                        <div>
                            <div class="flex items-center gap-1">
                                <!-- Select button (takes up most of the row) -->
                                <button
                                    class="flex-1 flex items-start gap-2 px-3 py-2 rounded text-sm transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed
                                    {isCurrentOrdering(ordering)
                                        ? 'bg-primary-600/30 text-primary-200'
                                        : 'text-surface-300 hover:bg-surface-700/60 hover:text-surface-100'}"
                                    onclick={() => selectOrdering(ordering)}
                                    disabled={saving || empty}>
                                    {#if applyingGroupId === ordering.groupId}
                                        <Icon
                                            src={ArrowPath}
                                            class="w-4 h-4 shrink-0 text-primary-400 mt-0.5 animate-spin" />
                                    {:else if isCurrentOrdering(ordering)}
                                        <Icon
                                            src={Check}
                                            class="w-4 h-4 shrink-0 text-primary-400 mt-0.5" />
                                    {:else}
                                        <span class="w-4 h-4 shrink-0"></span>
                                    {/if}
                                    <div class="flex-1 min-w-0">
                                        <div class="flex items-center gap-2">
                                            <span class="truncate">{ordering.name}</span>
                                            {#if gs}
                                                <span
                                                    class="text-xs px-1.5 py-0.5 rounded-full shrink-0
                                                {gs.score >= 0.6
                                                        ? 'bg-green-400/10 text-green-400'
                                                        : gs.score >= 0.3
                                                          ? 'bg-yellow-400/10 text-yellow-400'
                                                          : 'bg-gray-400/10 text-gray-400'}">
                                                    {(gs.score * 100).toFixed(0)}% match
                                                </span>
                                            {/if}
                                            {#if bestGroup && bestGroup.groupId === ordering.groupId && bestGroup.score >= 0.6}
                                                <span
                                                    class="text-xs px-1.5 py-0.5 rounded-full shrink-0 bg-primary-500/15 text-primary-400">
                                                    Suggested
                                                </span>
                                            {/if}
                                        </div>
                                        <p class="text-xs text-surface-400 mt-0.5">
                                            {empty
                                                ? m.modal_ordering_group_empty()
                                                : m.modal_ordering_group_stats({
                                                      episodes: ordering.episodeCount,
                                                      groups: ordering.groupCount,
                                                  })}
                                        </p>
                                        {#if ordering.description}
                                            <p class="text-xs text-surface-500 mt-1 line-clamp-2">
                                                {ordering.description}
                                            </p>
                                        {/if}
                                    </div>
                                </button>
                                <!-- Preview button -->
                                <button
                                    class="p-1.5 rounded transition-colors shrink-0
                                    text-surface-500 hover:text-surface-300 hover:bg-surface-700/40 disabled:opacity-40 disabled:pointer-events-none"
                                    onclick={() => openPreview(ordering)}
                                    title={m.modal_preview_ordering()}
                                    aria-label={m.modal_preview_ordering()}
                                    disabled={empty || loadingPreviews.has(ordering.groupId)}>
                                    {#if loadingPreviews.has(ordering.groupId)}
                                        <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                                    {:else}
                                        <Icon src={Eye} class="w-4 h-4" />
                                    {/if}
                                </button>
                            </div>
                        </div>
                    {/each}
                {/each}

                <!-- Footer row -->
                <div class="flex justify-end pt-1">
                    {#if saving}
                        <Icon src={ArrowPath} class="w-4 h-4 text-surface-400 animate-spin" />
                    {:else}
                        <button
                            class="flex items-center gap-1 text-xs text-surface-400 hover:text-surface-200 transition-colors px-2 py-1 rounded hover:bg-surface-700/40"
                            onclick={() => (editing = false)}>
                            <Icon src={XMark} class="w-3 h-3" />
                            {m.modal_ordering_cancel()}
                        </button>
                    {/if}
                </div>
            </div>
        {/if}
    </div>
{:else if showAdminEmpty}
    <div class="ordering-section mt-3">
        <div class="flex items-center gap-2 text-sm">
            <span class="text-surface-400 font-medium shrink-0">Episode Ordering</span>
            <span class="text-surface-200">Standard (default)</span>
        </div>
        <div class="mt-2 bg-surface-800/60 rounded-lg p-4 border border-surface-700/50 space-y-3">
            <p class="text-sm text-surface-400">
                No alternative orderings cached. Fetch from TMDB to check for DVD ordering, absolute
                ordering, or other episode groups.
            </p>
            <button
                class="btn variant-ghost-primary text-sm px-4 py-2 inline-flex items-center gap-2"
                onclick={fetchOrderings}
                disabled={fetching}>
                {#if fetching}
                    <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                    Fetching…
                {:else}
                    <Icon src={ArrowPath} class="w-4 h-4" />
                    Fetch from TMDB
                {/if}
            </button>
        </div>
    </div>
{:else if showReadOnlyBadge}
    <div class="mt-3 flex items-center gap-2 text-sm">
        <span class="text-surface-400 font-medium">Episode Ordering</span>
        <span class="px-2 py-0.5 rounded bg-surface-700/60 text-surface-300 text-xs">
            {getCurrentLabel()}
        </span>
    </div>
{/if}
