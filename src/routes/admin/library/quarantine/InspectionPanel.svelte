<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import { page } from '$app/state';
    import {
        adminWorkspaceUrl,
        writeAdminWorkspaceUrl,
    } from '$lib/components/admin/admin-workspace-url';
    import { inspectQuarantineGroup, resolveQuarantineEntry } from '$lib/api/admin';
    import type { QuarantineInspectionEntry } from '$lib/schemas/api-admin-responses.js';
    import { toasts } from '$lib/stores/toast.store';
    import { url } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { quarantineReason } from './reason-label.js';

    let {
        group,
        onclose,
        onchanged,
    }: { group: string; onclose: () => void; onchanged: () => void } = $props();
    let entries = $state<QuarantineInspectionEntry[]>([]);
    let total = $state(0);
    let continuation = $state<string | undefined>();
    let loading = $state(false);
    let failed = $state(false);
    let dismissing = $state<string | null>(null);
    let seq = 0;
    let currentGroup = '';
    let workspaceUrl = $derived(adminWorkspaceUrl(page.url, page.state));
    let selectedCursor = $derived(
        workspaceUrl.searchParams.get('inspect') === group
            ? (workspaceUrl.searchParams.get('after') ?? undefined)
            : undefined,
    );

    function selectPage(cursor?: string): void {
        const unchanged =
            selectedCursor === cursor && workspaceUrl.searchParams.get('inspect') === group;
        const destination = new URL(workspaceUrl);
        destination.searchParams.set('inspect', group);
        if (cursor) destination.searchParams.set('after', cursor);
        else destination.searchParams.delete('after');
        writeAdminWorkspaceUrl(destination, page.state, true);
        if (unchanged) void load(group, cursor);
    }

    async function load(key: string, cursor?: string): Promise<void> {
        const request = ++seq;
        loading = true;
        failed = false;
        entries = [];
        continuation = undefined;
        try {
            const { data, error } = await inspectQuarantineGroup(key, cursor);
            if (request !== seq || key !== currentGroup) return;
            if (error || !data) {
                failed = true;
                return;
            }
            entries = data.items;
            total = data.total;
            continuation = data.continuation;
        } catch {
            if (request === seq) failed = true;
        } finally {
            if (request === seq) loading = false;
        }
    }
    async function dismiss(entry: QuarantineInspectionEntry): Promise<void> {
        if (dismissing) return;
        const key = group;
        dismissing = entry.id;
        try {
            const { data, error } = await resolveQuarantineEntry(
                entry.id,
                'dismissed',
                entry.fingerprint,
            );
            if (error || !data) toasts.error(m.admin_quarantine_inspection_changed());
            if (key === currentGroup) await load(key, selectedCursor);
            onchanged();
        } catch {
            toasts.error(m.admin_quarantine_dismiss_failed());
        } finally {
            dismissing = null;
        }
    }
    $effect(() => {
        const key = group;
        const cursor = selectedCursor;
        untrack(() => {
            currentGroup = key;
            void load(key, cursor);
        });
        return () => {
            seq++;
        };
    });
</script>

<section
    class="rounded-xl border border-surface-700 p-4 space-y-4"
    aria-label={m.admin_quarantine_inspection_title()}>
    <div class="flex justify-between gap-3">
        <h2 class="font-semibold">{m.admin_quarantine_inspection_title()}</h2>
        <button type="button" class="btn btn-ghost" onclick={onclose}>{m.close()}</button>
    </div>
    <p class="text-sm text-surface-400">{m.admin_quarantine_inspection_help()}</p>
    {#if !loading && !failed}
        <p class="text-sm">{m.admin_quarantine_inspection_count({ count: total })}</p>
    {/if}
    <button
        type="button"
        class="btn btn-ghost"
        disabled={loading || !!dismissing}
        onclick={() => selectPage()}>{m.admin_quarantine_inspection_refresh()}</button>
    {#if loading}
        <p role="status">{m.admin_quarantine_loading()}</p>
    {:else if failed}
        <p role="alert">{m.admin_quarantine_load_error()}</p>
    {:else if entries.length === 0}
        <p>{m.admin_quarantine_inspection_empty()}</p>
    {/if}
    {#each entries as entry (entry.id)}
        <article class="border-t border-surface-700 pt-4 space-y-2">
            <h3 class="font-semibold">
                {entry.current?.mediaType === 'episode'
                    ? m.media_plain_episode_name({
                          title: entry.current.title,
                          season: entry.current.seasonNumber ?? 0,
                          episode: entry.current.episodeNumber ?? 0,
                      })
                    : (entry.current?.title ?? quarantineReason(entry.reason))}
            </h3>
            {#if entry.current?.seriesTitle}<p class="text-sm">{entry.current.seriesTitle}</p>{/if}
            <p class="text-sm">{quarantineReason(entry.reason)}</p>
            <p class="text-xs text-surface-400">
                {entry.provider} · {new Date(entry.createdAt).toLocaleString()}
            </p>
            <h4 class="text-sm font-semibold">{m.admin_quarantine_inspection_history()}</h4>
            <p class="text-sm">
                {entry.proposedTitle || entry.proposedTmdbEpisodeId
                    ? m.admin_quarantine_inspection_proposed({
                          title: entry.proposedTitle ?? '—',
                          id: entry.proposedTmdbEpisodeId ?? '—',
                      })
                    : m.admin_quarantine_inspection_no_proposal()}
            </p>
            <details>
                <summary class="cursor-pointer text-sm"
                    >{m.admin_quarantine_inspection_raw()}</summary>
                <p class="text-sm">
                    {m.admin_quarantine_inspection_expected({
                        id: entry.historicalSeriesId ?? '—',
                    })}
                </p>
                {#if entry.parentTmdbId}<p class="text-sm">
                        {m.admin_quarantine_tmdb_series({ id: entry.parentTmdbId })}
                    </p>{/if}

                <p>{entry.externalId} · {entry.reason}</p>
                <pre
                    class="overflow-auto max-h-64 text-xs whitespace-pre-wrap break-all">{JSON.stringify(
                        entry.payload,
                        null,
                        2,
                    )}</pre>
            </details>
            <h4 class="text-sm font-semibold">{m.admin_quarantine_inspection_current()}</h4>
            {#if entry.subjectState === 'moved'}<p class="text-sm text-orange-400">
                    {m.admin_quarantine_inspection_moved()}
                </p>{/if}
            {#if entry.current}
                <p>
                    {entry.current.title} · {entry.current.seriesTitle ?? '—'}
                </p>
                {#if entry.current.detailAvailable}
                    <div class="flex flex-wrap gap-4 text-sm">
                        <a
                            class="anchor"
                            href={url(`/admin/library/media/${entry.current.id}`)}
                            target="_blank"
                            rel="noopener noreferrer"
                            >{entry.current.mediaType === 'episode'
                                ? m.media_plain_open_episode({
                                      title: entry.current.title ?? m.media_plain_episode(),
                                  })
                                : m.admin_quarantine_inspection_current()}</a>
                        {#if entry.current.mediaType === 'episode'}<a
                                class="anchor"
                                href={url(`/admin/library/media/${entry.current.id}?tab=files`)}
                                target="_blank"
                                rel="noopener noreferrer"
                                >{m.admin_quarantine_inspection_files({
                                    count: entry.current.fileCount,
                                })}</a
                            >{/if}
                        <a
                            class="anchor"
                            href={url(
                                `/admin/library/media/${entry.current.id}?tab=maintenance&section=metadata`,
                            )}
                            target="_blank"
                            rel="noopener noreferrer">{m.admin_quarantine_inspection_metadata()}</a>
                    </div>
                {:else}<p class="text-sm text-surface-400">
                        {m.admin_quarantine_inspection_hierarchy_unavailable()}
                    </p>{/if}
            {:else}<p class="text-sm text-surface-400">
                    {m.admin_quarantine_inspection_unavailable()}
                </p>{/if}
            <button
                type="button"
                class="btn btn-ghost text-orange-400"
                disabled={!!dismissing}
                onclick={() => dismiss(entry)}>{m.admin_quarantine_inspection_dismiss()}</button>
        </article>
    {/each}
    {#if continuation && !loading && !failed}
        <button
            type="button"
            class="btn btn-ghost"
            disabled={!!dismissing}
            onclick={() => selectPage(continuation)}>{m.admin_quarantine_inspection_next()}</button>
    {/if}
</section>
