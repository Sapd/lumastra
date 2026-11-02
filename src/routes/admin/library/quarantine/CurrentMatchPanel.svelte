<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import HelpPopover from '$lib/components/admin/HelpPopover.svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { onMount } from 'svelte';
    import { resolveQuarantineSeriesGroup } from '$lib/api/admin';
    import type {
        QuarantineGroupResolveResponse,
        QuarantineSeriesGroup,
    } from '$lib/schemas/api-admin-library-responses.js';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import { url } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    type Review = NonNullable<QuarantineGroupResolveResponse['currentMatchReview']>[number];
    let {
        group,
        onclose,
        onchanged,
    }: {
        group: QuarantineSeriesGroup;
        onclose: () => void;
        onchanged: () => void;
    } = $props();
    let cursor = $state<string | undefined>();
    let next = $state<string | undefined>();
    let review = $state<Review[]>([]);
    let reviewedPage = $state<QuarantineGroupResolveResponse['reviewedPage']>();
    let examined = $state(0);
    let busy = $state(false);
    let failed = $state(false);
    let stale = $state(false);
    let result = $state<{ examined: number; resolved: number; retained: number } | null>(null);
    const selected = new SvelteSet<string>();

    function reason(reason: string | undefined): string {
        switch (reason) {
            case 'historical-target-unconfirmed':
                return m.admin_quarantine_current_reason_no_target();
            case 'identity-bound':
                return m.admin_quarantine_current_reason_identity_bound();
            case 'inactive-or-protected':
                return m.admin_quarantine_current_reason_protected();
            case 'missing-current-episode':
                return m.admin_quarantine_current_reason_missing();
            case 'wrong-series-or-season':
                return m.admin_quarantine_current_reason_hierarchy();
            case 'wrong-series-tmdb':
                return m.admin_quarantine_current_reason_series_id();
            case 'wrong-episode-identity':
                return m.admin_quarantine_current_reason_episode_id();
            case 'wrong-title-or-position':
                return m.admin_quarantine_current_reason_title();
            case 'no-default-file':
                return m.admin_quarantine_current_reason_file();
            case 'not-position-bound':
                return m.admin_quarantine_current_reason_binding();
            default:
                return m.admin_quarantine_current_reason_invalid();
        }
    }

    async function load(after = cursor): Promise<void> {
        if (!group.seriesId || busy) return;
        busy = true;
        failed = false;
        stale = false;
        result = null;
        selected.clear();
        try {
            const { data, error } = await resolveQuarantineSeriesGroup({
                seriesId: group.seriesId,
                action: 'preview-current-match',
                after,
            });
            if (error || !data || !data.reviewedPage || !data.currentMatchReview) {
                failed = true;
                toasts.error(getErrorMessage(error, m.admin_quarantine_current_failed()));
                return;
            }
            cursor = after;
            next = data.continuation;
            examined = data.examined ?? 0;
            reviewedPage = data.reviewedPage;
            review = data.currentMatchReview;
        } catch (error) {
            failed = true;
            toasts.error(getErrorMessage(error, m.admin_quarantine_current_failed()));
        } finally {
            busy = false;
        }
    }

    function requestConfirm(): void {
        if (!reviewedPage || selected.size === 0 || busy) return;
        const rows = review.filter((row) => selected.has(row.id) && row.eligible);
        if (rows.length === selected.size) void confirm(rows);
    }

    async function confirm(rows: Review[]): Promise<void> {
        if (!group.seriesId || !reviewedPage || busy) return;
        busy = true;
        failed = false;
        try {
            const { data, error } = await resolveQuarantineSeriesGroup({
                seriesId: group.seriesId,
                action: 'confirm-current-match',
                after: cursor,
                reviewedPage,
                reviewed: rows.map(({ id, fingerprint }) => ({ id, fingerprint })),
            });
            if (error || !data) {
                failed = true;
                toasts.error(getErrorMessage(error, m.admin_quarantine_current_failed()));
                return;
            }
            if (data.pageChanged) {
                stale = true;
                review = [];
                reviewedPage = undefined;
                selected.clear();
                return;
            }
            result = {
                examined: data.examined ?? 0,
                resolved: data.resolved,
                retained: data.retained ?? 0,
            };
            next = data.continuation;
            review = [];
            reviewedPage = undefined;
            selected.clear();
            onchanged();
        } catch (error) {
            failed = true;
            toasts.error(getErrorMessage(error, m.admin_quarantine_current_failed()));
        } finally {
            busy = false;
        }
    }

    onMount(() => {
        void load();
    });
</script>

<section
    class="rounded-xl border border-surface-700 p-4 space-y-4"
    aria-label={m.admin_quarantine_current_title()}>
    <div class="flex items-start justify-between gap-3">
        <h2 class="min-w-0 flex-1 break-words text-base font-semibold leading-snug sm:text-lg">
            {m.admin_quarantine_current_title()} · {group.seriesTitle ?? m.media_plain_series()}
        </h2>
        <button class="btn btn-ghost shrink-0" type="button" onclick={onclose}>{m.close()}</button>
    </div>
    <p class="text-sm text-surface-400">{m.media_plain_current_match_action()}</p>
    <HelpPopover variant="inline"><p>{m.admin_quarantine_current_help()}</p></HelpPopover>
    {#if busy}<p role="status">{m.admin_quarantine_loading()}</p>{/if}
    {#if failed}<p role="alert" class="text-orange-400">
            {m.admin_quarantine_current_failed()}
        </p>{/if}
    {#if stale}<p role="alert" class="text-orange-400">{m.admin_quarantine_current_stale()}</p>{/if}
    {#if result}<p role="status">{m.admin_quarantine_current_result(result)}</p>{/if}
    {#if reviewedPage}
        <p class="text-sm">
            {m.admin_quarantine_current_preview_count({
                count: examined,
                eligible: review.filter((row) => row.eligible).length,
            })}
        </p>
        <div
            class="max-h-[32rem] overflow-y-auto space-y-2"
            role="group"
            aria-label={m.admin_quarantine_current_title()}>
            {#each review as row (row.id)}
                <article class="rounded-lg border border-surface-700 p-3 space-y-1 text-sm">
                    <label class="flex items-start gap-2">
                        <input
                            type="checkbox"
                            checked={selected.has(row.id)}
                            disabled={!row.eligible || busy}
                            onchange={(event) => {
                                if (event.currentTarget.checked) selected.add(row.id);
                                else selected.delete(row.id);
                            }} />
                        <span class="font-medium"
                            >{m.media_plain_episode_name({
                                title:
                                    row.currentTitle ??
                                    row.proposedTitle ??
                                    m.media_plain_episode(),
                                season: row.currentSeasonNumber ?? 0,
                                episode: row.currentEpisodeNumber ?? 0,
                            })}</span>
                    </label>
                    <p>
                        {m.media_plain_proposed_match({
                            title: row.proposedTitle ?? m.media_plain_episode(),
                            season: row.proposedSeasonNumber ?? 0,
                            episode: row.proposedEpisodeNumber ?? 0,
                        })}
                    </p>
                    <details>
                        <summary>{m.media_plain_technical_details()}</summary>
                        <p>
                            {m.admin_quarantine_current_proposed({
                                title: row.proposedTitle ?? '—',
                                id: row.proposedTmdbEpisodeId ?? '—',
                                season: row.proposedSeasonNumber ?? 0,
                                episode: row.proposedEpisodeNumber ?? 0,
                            })}
                        </p>
                        <p>
                            {m.admin_quarantine_current_actual({
                                title: row.currentTitle ?? '—',
                                id: row.currentTmdbEpisodeId ?? '—',
                                season: row.currentSeasonNumber ?? 0,
                                episode: row.currentEpisodeNumber ?? 0,
                                series: row.currentSeriesId ?? '—',
                            })}
                        </p>
                        <p>
                            {m.admin_quarantine_current_binding({
                                binding: row.titleBinding ?? '—',
                            })}
                        </p>
                    </details>
                    {#if row.retainedReason}<p class="text-orange-400">
                            {reason(row.retainedReason)}
                        </p>{/if}
                    {#if row.currentSeriesId}<a
                            class="anchor"
                            href={url(
                                `/admin/library/media/${row.episodeId}?tab=maintenance&section=metadata`,
                            )}
                            target="_blank"
                            rel="noopener noreferrer">{m.admin_quarantine_current_individual()}</a
                        >{/if}
                </article>
            {/each}
        </div>
        <button
            type="button"
            class="btn btn-primary"
            disabled={busy || selected.size === 0}
            onclick={requestConfirm}
            >{m.admin_quarantine_current_confirm_selected({ count: selected.size })}</button>
    {/if}
    <div class="flex gap-2">
        <button type="button" class="btn btn-ghost" disabled={busy} onclick={() => load(cursor)}
            >{m.common_retry()}</button>
        {#if next}<button
                type="button"
                class="btn btn-ghost"
                disabled={busy}
                onclick={() => load(next)}>{m.admin_quarantine_current_next()}</button
            >{/if}
    </div>
</section>
