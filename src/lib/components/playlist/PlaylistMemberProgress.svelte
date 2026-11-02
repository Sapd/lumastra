<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import AvatarProgressRing from './AvatarProgressRing.svelte';
    import { Icon, Users, Trophy } from 'svelte-hero-icons';
    import type { MemberProgress } from '$lib/types/playlist';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        /**
         * Shows member progress for a shared playlist
         * Displays stacked avatars with progress rings
         */
        members?: MemberProgress[];
        currentUser?: string | null;
        compact?: boolean;
    }

    let { members = [], currentUser = null, compact = false }: Props = $props();

    // Sort by progress (highest first), then by username
    let sortedMembers = $derived(
        [...members].sort((a, b) => {
            // Current user always first
            if (a.userId === currentUser) return -1;
            if (b.userId === currentUser) return 1;
            // Then by progress
            if (b.progressPercent !== a.progressPercent) {
                return b.progressPercent - a.progressPercent;
            }
            return a.userId.localeCompare(b.userId);
        }),
    );

    // Leader (excluding current user for "race" feel)
    let leader = $derived(
        sortedMembers.find((m) => m.userId !== currentUser && m.progressPercent > 0),
    );
    let currentUserProgress = $derived(members.find((m) => m.userId === currentUser));

    // Display limits
    let displayMembers = $derived(compact ? sortedMembers.slice(0, 4) : sortedMembers.slice(0, 6));
    let remainingCount = $derived(sortedMembers.length - displayMembers.length);

    // Check if it's a shared playlist (more than 1 member)
    let isShared = $derived(members.length > 1);
</script>

{#if members.length > 0}
    <div class="flex items-center gap-3">
        <!-- Member avatars stack -->
        <div class="flex items-center">
            <div class="flex -space-x-2">
                {#each displayMembers as member, i (member.userId)}
                    <div
                        class="relative transition-transform hover:scale-110 hover:z-10"
                        style="z-index: {displayMembers.length - i};">
                        <AvatarProgressRing
                            userId={member.userId}
                            progress={member.progressPercent}
                            watchedCount={member.watchedCount}
                            totalCount={member.totalCount}
                            size={compact ? 36 : 44} />
                    </div>
                {/each}

                <!-- Overflow indicator -->
                {#if remainingCount > 0}
                    <div
                        class="relative center rounded-full
                               bg-surface-700 border-2 border-surface-900 text-surface-300
                               font-medium text-xs"
                        style="
                            width: {compact ? 36 : 44}px;
                            height: {compact ? 36 : 44}px;
                            z-index: 0;
                        ">
                        +{remainingCount}
                    </div>
                {/if}
            </div>
        </div>

        <!-- Progress summary text -->
        {#if !compact && isShared}
            <div class="flex flex-col text-sm">
                <span class="text-surface-400 flex items-center gap-1">
                    <Icon src={Users} class="w-4 h-4" mini />
                    {m.playlist_members_count({ count: members.length })}
                </span>

                <!-- Leader indicator -->
                {#if leader && currentUserProgress && leader.progressPercent > currentUserProgress.progressPercent}
                    <span class="text-xs text-warning-400 flex items-center gap-1">
                        <Icon src={Trophy} class="w-3 h-3" mini />
                        {m.playlist_leader_progress({
                            username: leader.userId,
                            percent: leader.progressPercent,
                        })}
                    </span>
                {:else if currentUserProgress?.progressPercent === 100}
                    <span class="text-xs text-success-400">
                        {m.playlist_all_watched()}
                    </span>
                {/if}
            </div>
        {/if}
    </div>
{/if}
