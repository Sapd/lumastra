<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * Quick Picks tab content for Settings → Music (admin IA redesign, spec
     * §3.6: music + alchemy + quick-picks as tabs on ONE page). Ported
     * near-verbatim from the deleted standalone `/admin/music-quick-picks`
     * page — same markup, now fed by `MusicQuickPicksData` instead of a
     * dedicated route's `PageData`.
     */
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import { Icon, MusicalNote, Sparkles } from 'svelte-hero-icons';
    import { AdminPageHeader, StatCard } from '$lib/components/admin';
    import type { MusicQuickPicksData } from '$lib/server/admin/music-quick-picks-data';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        data: MusicQuickPicksData;
    }

    let { data }: Props = $props();

    // Mirror server-resolved selection so the controlled <select> follows
    // navigations triggered by pickUser() below.
    let selectedUser = $derived(data.selectedUserId ?? '');

    const BUCKET_LABELS: Record<string, string> = {
        'heavy-rotation': m.admin_musicpicks_bucket_heavy_rotation(),
        'recently-heard': m.admin_musicpicks_bucket_recently_heard(),
        'hot-this-week': m.admin_musicpicks_bucket_hot_this_week(),
        'taste-similar': m.admin_musicpicks_bucket_taste_similar(),
        'new-discovery': m.admin_musicpicks_bucket_new_discovery(),
        'highly-rated': m.admin_musicpicks_bucket_highly_rated(),
        'unplayed-from-loved-albums': m.admin_musicpicks_bucket_unplayed_loved(),
        'co-album': m.admin_musicpicks_bucket_co_album(),
        'deep-cuts': m.admin_musicpicks_bucket_deep_cuts(),
        random: m.admin_musicpicks_bucket_random(),
    };

    function pickUser(userId: string): void {
        const u = new URL($page.url);
        if (userId) u.searchParams.set('userId', userId);
        else u.searchParams.delete('userId');
        void goto(u.pathname + u.search, {
            replaceState: false,
            keepFocus: true,
        });
    }

    let todayTotal = $derived(data.todayStats.reduce((s, b) => s + b.count, 0));
    let weekTotal = $derived(data.weekStats.reduce((s, b) => s + b.count, 0));
</script>

<div class="space-y-6">
    <AdminPageHeader
        icon={MusicalNote}
        title={m.admin_musicpicks_title()}
        description={m.admin_musicpicks_description()} />

    {#if !data.featureClusteringEnabled}
        <div
            class="rounded-md border border-yellow-500/40 bg-yellow-950/40 p-3 text-sm text-yellow-300">
            <strong>{m.admin_music_feature_flag_off()}</strong>
            <code>FEATURE_MUSIC_CLUSTERING=false</code>
            {m.admin_musicpicks_clustering_disabled_note()}
        </div>
    {/if}

    <!-- Bucket distribution -->
    <section class="space-y-3">
        <h2 class="text-lg font-semibold text-white">
            {m.admin_musicpicks_bucket_distribution_today({ date: data.today })}
            <span class="text-xs text-muted font-normal">UTC</span>)
        </h2>
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {#each data.todayStats as bucket (bucket.bucket)}
                <StatCard
                    icon={MusicalNote}
                    title={BUCKET_LABELS[bucket.bucket] ?? bucket.bucket}
                    value={bucket.count}
                    subtitle={todayTotal > 0
                        ? `${Math.round((bucket.count / todayTotal) * 100)}% of today`
                        : '—'} />
            {/each}
        </div>
        <p class="text-xs text-muted">
            {m.admin_musicpicks_today_total_note({ total: todayTotal })}
        </p>
    </section>

    <!-- 7-day rollup -->
    <section class="space-y-3">
        <h2 class="text-lg font-semibold text-white">
            {m.admin_music_last_7_days()}
            <span class="text-xs text-muted font-normal">{m.admin_music_utc_days()}</span>
        </h2>
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {#each data.weekStats as bucket (bucket.bucket)}
                <StatCard
                    icon={Sparkles}
                    title={BUCKET_LABELS[bucket.bucket] ?? bucket.bucket}
                    value={bucket.count}
                    subtitle={weekTotal > 0
                        ? `${Math.round((bucket.count / weekTotal) * 100)}% of week`
                        : '—'} />
            {/each}
        </div>
        <p class="text-xs text-muted">
            {m.admin_musicpicks_week_total_note_before({ total: weekTotal })}
            <code>unplayed-from-loved-albums</code>
            {m.admin_musicpicks_week_total_note_or()}
            <code>co-album</code>
            {m.admin_musicpicks_week_total_note_after()}
        </p>
    </section>

    <!-- Cluster inspector -->
    <section class="space-y-3">
        <div class="flex items-center gap-2">
            <Icon src={Sparkles} class="w-5 h-5 text-yellow-400" />
            <h2 class="text-lg font-semibold text-white">
                {m.admin_musicpicks_cluster_inspector()}
            </h2>
        </div>

        <div class="flex flex-wrap items-center gap-2">
            <label class="text-sm text-muted" for="quick-picks-user-select"
                >{m.admin_music_user_colon()}</label>
            <select
                id="quick-picks-user-select"
                class="bg-surface-700 text-white text-sm rounded px-2 py-1 border border-surface-600"
                value={selectedUser}
                onchange={(e) => pickUser(e.currentTarget.value)}>
                <option value="">{m.admin_music_pick_user()}</option>
                {#each data.musicUsers as user (user.userId)}
                    <option value={user.userId}
                        >{user.userId} ({m.admin_musicpicks_n_tracks({
                            count: user.playedCount,
                        })})</option>
                {/each}
            </select>
        </div>

        {#if data.selectedUserId && data.selectedUserFallback}
            <div
                class="rounded-md border border-blue-500/40 bg-blue-950/40 p-3 text-sm text-blue-300">
                {m.admin_musicpicks_fallback_before()}
                <code>{data.selectedUserId}</code>
                {m.admin_musicpicks_fallback_after()}
            </div>
        {:else if data.selectedUserClusters}
            <div class="grid gap-3 lg:grid-cols-3">
                {#each data.selectedUserClusters as cluster, i (i)}
                    <div class="rounded-lg border border-surface-600 bg-surface-800 p-3">
                        <div class="flex items-center justify-between mb-2">
                            <span class="text-sm font-semibold text-white"
                                >{m.admin_musicpicks_cluster_n({ n: i + 1 })}</span>
                            <span class="text-xs text-muted"
                                >{m.admin_musicpicks_n_tracks({ count: cluster.size })}</span>
                        </div>
                        <ul class="space-y-1 text-xs">
                            {#each cluster.sampleTracks as track (track.id)}
                                <li class="text-white/80 truncate">
                                    <span class="font-medium">{track.title}</span>
                                    {#if track.artist}
                                        <span class="text-muted">— {track.artist}</span>
                                    {/if}
                                </li>
                            {/each}
                            {#if cluster.sampleTracks.length === 0}
                                <li class="text-muted italic">
                                    {m.admin_musicpicks_no_sample_tracks()}
                                </li>
                            {/if}
                        </ul>
                    </div>
                {/each}
            </div>
            <p class="text-xs text-muted">
                {m.admin_musicpicks_centroid_note()}
            </p>
        {:else if data.selectedUserId}
            <div class="text-sm text-muted">
                {m.admin_music_loading_clusters()}
            </div>
        {/if}
    </section>
</div>
