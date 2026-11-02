<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
    import * as m from '$lib/paraglide/messages';
    import StatsUserAvatar from './StatsUserAvatar.svelte';

    interface Props {
        /**
         * User Rank Card Component
         * Displays a user's ranking, avatar, and statistics in a leaderboard format
         */
        rank: number;
        user: {
            name: string;
            images?: ImageSet;
            totalPlayTime?: string;
            minutes?: number;
            sessions: number;
            avgSessionLength: number;
        };
    }

    let { rank, user }: Props = $props();

    // Gradient colors for top 3 ranks
    let gradientColors = $derived(
        rank === 1
            ? 'from-yellow-500 to-yellow-600'
            : rank === 2
              ? 'from-surface-400 to-surface-500'
              : rank === 3
                ? 'from-orange-600 to-orange-700'
                : 'from-blue-500 to-blue-600',
    );
</script>

<div
    class="bg-surface-700/50 rounded-lg p-3 border border-surface-600/50 hover:border-surface-500 transition-all">
    <div class="between gap-4">
        <!-- Left: Rank, Avatar, Name -->
        <div class="flex items-center gap-3 flex-1 min-w-0">
            <!-- Rank Badge -->
            <div
                class="w-8 h-8 center rounded-full bg-gradient-to-br {gradientColors} text-white font-bold text-sm shrink-0 shadow-lg"
                aria-label={m.admin_stats_rank_label({ rank })}>
                <span aria-hidden="true">#{rank}</span>
            </div>

            <!-- User Avatar -->
            <StatsUserAvatar name={user.name} images={user.images} />

            <!-- Name and Watch Time -->
            <div class="min-w-0 flex-1">
                <h4 class="font-medium text-white truncate">
                    {user.name || m.admin_unknown_user()}
                </h4>
                <p class="text-hint">
                    {user.totalPlayTime ||
                        m.admin_stats_user_hours_watched({
                            hours: Math.round((user.minutes || 0) / 60),
                        })}
                </p>
            </div>
        </div>

        <!-- Right: Stats -->
        <div class="flex items-center gap-4 shrink-0">
            <div class="text-center">
                <div class="text-hint">{m.sessions()}</div>
                <div class="text-sm font-bold text-blue-400">
                    {user.sessions || 0}
                </div>
            </div>
            <div class="text-center">
                <div class="text-hint">{m.admin_stats_avg_session()}</div>
                <div class="text-sm font-bold text-green-400">
                    {user.avgSessionLength || 0}m
                </div>
            </div>
        </div>
    </div>
</div>
