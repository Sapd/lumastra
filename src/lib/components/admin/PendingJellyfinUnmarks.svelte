<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    Repudiated jellyfin-sync windows whose Jellyfin unmark may not have taken
    (last audited attempt failed, did not unmark, or left no record), with a
    retry. The retry repeats the repudiate request with the window's own
    bounds; the endpoint then unmarks every media repudiated there that the
    user has not watched since.
-->
<script lang="ts">
    import { z } from 'zod';
    import { Icon, ArrowPath } from 'svelte-hero-icons';
    import { apiPost } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages.js';
    import type {
        JellyfinUnmarkStats,
        PendingJellyfinUnmarkWindow,
    } from '$lib/server/database/queries/user-media-events.queries.js';

    interface Props {
        userId: string;
        windows: PendingJellyfinUnmarkWindow[];
        /** Called after each retry, e.g. to reload the page data. */
        onretried?: () => Promise<void> | void;
        formatRelative: (iso: string) => string;
        formatDurationMs: (ms: number) => string;
    }

    let { userId, windows, onretried, formatRelative, formatDurationMs }: Props = $props();

    const RetryResponseSchema = z.object({
        jellyfinUnmark: z
            .object({
                attempted: z.number(),
                succeeded: z.number(),
                failed: z.number(),
                skippedNoExternalId: z.number(),
            })
            .nullable(),
    });

    const keyOf = (w: PendingJellyfinUnmarkWindow): string => `${w.repudiated_at}|${w.from_ts}`;

    let retrying = $state<string | null>(null);
    /**
     * This page's own retry results: the audit row the list reads is written
     * after the response, so a reload right away may still show the old one.
     */
    let results = $state<Record<string, JellyfinUnmarkStats | null>>({});

    async function retry(w: PendingJellyfinUnmarkWindow): Promise<void> {
        if (retrying) return;
        const key = keyOf(w);
        retrying = key;
        try {
            const { data, error } = await apiPost(
                '/api/admin/watch-events/repudiate',
                RetryResponseSchema,
                { userId, source: 'jellyfin-sync', fromTs: w.from_ts, toTs: w.to_ts },
            );
            if (error || !data) {
                toasts.show(
                    m.admin_provenance_toast_repudiation_failed({ error: error ?? '' }),
                    'error',
                );
                return;
            }
            const unmark = data.jellyfinUnmark;
            results[key] = unmark;
            if (!unmark) {
                toasts.show(m.admin_provenance_toast_unmark_nothing(), 'success');
            } else {
                toasts.show(
                    m.admin_provenance_toast_unmark_retried({
                        succeeded: unmark.succeeded,
                        attempted: unmark.attempted,
                        failed: unmark.failed,
                        skipped: unmark.skippedNoExternalId,
                    }),
                    unmark.failed > 0 ? 'warning' : 'success',
                );
            }
            await onretried?.();
        } finally {
            retrying = null;
        }
    }

    function attemptLabel(w: PendingJellyfinUnmarkWindow): string {
        const key = keyOf(w);
        const stats = key in results ? results[key] : w.last_unmark;
        if (stats) {
            return m.admin_provenance_pending_unmark_failed({
                failed: stats.failed,
                attempted: stats.attempted,
            });
        }
        if (key in results || w.last_attempt_at) {
            return m.admin_provenance_pending_unmark_not_attempted();
        }
        return m.admin_provenance_pending_unmark_no_record();
    }
</script>

{#if windows.length > 0}
    <div class="rounded-xl border border-sky-500/20 bg-sky-500/5 overflow-hidden">
        <div class="px-4 py-3 border-b border-sky-500/20">
            <div class="flex items-center gap-2">
                <Icon src={ArrowPath} class="w-5 h-5 text-sky-400" />
                <h3 class="text-sm font-semibold text-sky-100">
                    {m.admin_provenance_pending_unmark_title()}
                </h3>
                <span class="text-xs text-sky-300/70 ml-auto">
                    {m.admin_provenance_detected({ count: windows.length })}
                </span>
            </div>
            <p class="text-xs text-sky-200/70 mt-1">
                {m.admin_provenance_pending_unmark_description()}
            </p>
        </div>
        <div class="overflow-x-auto">
            <table class="w-full text-xs">
                <thead class="bg-sky-500/10 text-sky-200/80">
                    <tr>
                        <th class="px-3 py-2 text-left"
                            >{m.admin_provenance_pending_unmark_col_repudiated()}</th>
                        <th class="px-3 py-2 text-left">{m.audit_col_window_start()}</th>
                        <th class="px-3 py-2 text-right">{m.admin_provenance_duration()}</th>
                        <th class="px-3 py-2 text-right">{m.audit_col_events()}</th>
                        <th class="px-3 py-2 text-right"
                            >{m.admin_provenance_pending_unmark_col_items()}</th>
                        <th class="px-3 py-2 text-left"
                            >{m.admin_provenance_pending_unmark_col_last_attempt()}</th>
                        <th class="px-3 py-2 text-right">{m.common_actions()}</th>
                    </tr>
                </thead>
                <tbody>
                    {#each windows as w (keyOf(w))}
                        <tr class="border-t border-sky-500/10 hover:bg-sky-500/5">
                            <td class="px-3 py-2 text-sky-100" title={w.repudiated_at}>
                                {formatRelative(w.repudiated_at)}
                            </td>
                            <td class="px-3 py-2 text-sky-100" title="{w.from_ts} → {w.to_ts}">
                                {formatRelative(w.from_ts)}
                            </td>
                            <td class="px-3 py-2 text-right font-mono text-sky-200/80">
                                {formatDurationMs(
                                    Math.max(0, Date.parse(w.to_ts) - Date.parse(w.from_ts)),
                                )}
                            </td>
                            <td class="px-3 py-2 text-right font-mono text-sky-200/80">
                                {w.event_count.toLocaleString()}
                            </td>
                            <td class="px-3 py-2 text-right font-mono text-sky-100 font-semibold">
                                {w.pending_media_count.toLocaleString()}
                            </td>
                            <td
                                class="px-3 py-2 text-sky-200/80"
                                title={w.last_attempt_at ?? undefined}>
                                {attemptLabel(w)}
                            </td>
                            <td class="px-3 py-2 text-right">
                                <button
                                    class="px-2 py-1 rounded text-[10px] font-medium bg-sky-500/30 text-sky-100 hover:bg-sky-500/50 disabled:opacity-50"
                                    disabled={retrying !== null}
                                    onclick={() => retry(w)}
                                    >{retrying === keyOf(w)
                                        ? m.admin_provenance_pending_unmark_retrying()
                                        : m.admin_provenance_pending_unmark_retry()}</button>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    </div>
{/if}
