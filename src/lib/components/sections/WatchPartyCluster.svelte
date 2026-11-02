<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    @component
    Overlapping avatars for the participants of one watch party on an Active
    Streams card: host first with a crown, a sync dot on the stack, and a
    tooltip listing each participant's offset from the host (+0.4s), device,
    and buffering state. Data comes from the `watchParty` tag the server puts on
    each stream row (watch-party-stream-overlay.ts).
-->
<script module lang="ts">
    import type { WatchPartySyncState } from './watch-party-groups';

    /** Trusted, fixed class names for the tooltip's styled lines. */
    export const SYNC_DOT_CLASS: Record<WatchPartySyncState, string> = {
        synced: 'bg-success-500',
        drifting: 'bg-warning-500',
        buffering: 'bg-warning-500 animate-pulse',
        paused: 'bg-surface-400',
        unknown: 'bg-surface-500',
    };
</script>

<script lang="ts">
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import Tooltip, { type TooltipLine } from '$lib/components/ui/Tooltip.svelte';
    import { getAvatarUrl } from '$lib/utils/image-utils';
    import { displayName } from '$lib/utils/data-extraction';
    import * as m from '$lib/paraglide/messages';
    import { formatPartyDrift, partySyncLabel, type WatchPartyMember } from './watch-party-groups';

    interface Props {
        members: WatchPartyMember[];
        syncState: WatchPartySyncState;
        /** Whether device names may be shown (same gate as the card's tech info). */
        showDevices: boolean;
    }

    let { members, syncState, showDevices }: Props = $props();

    /** Show at most this many faces; the rest collapse into "+N". */
    const MAX_FACES = 4;
    let faces = $derived(members.slice(0, MAX_FACES));
    let overflow = $derived(Math.max(0, members.length - MAX_FACES));

    let stalledName = $derived(members.find((mb) => mb.isStalled)?.displayName);

    let tooltipLines = $derived.by((): TooltipLine[] => {
        const lines: TooltipLine[] = [
            { text: partySyncLabel(syncState, stalledName), class: 'font-semibold' },
        ];
        for (const mb of members) {
            const parts = [displayName(mb.displayName)];
            if (mb.isHost) parts.push(m.session_party_host());
            if (mb.isStalled) parts.push(m.session_party_buffering_short());
            else if (!mb.isHost) parts.push(formatPartyDrift(mb.driftSeconds));
            if (showDevices && mb.device) parts.push(mb.device);
            lines.push({ text: parts.join(' · ') });
        }
        return lines;
    });
</script>

<Tooltip lines={tooltipLines} position="top" fixed inline>
    <span
        class="party-stack relative inline-flex items-center"
        role="img"
        aria-label={`${m.session_party_watching_together({ count: members.length })} — ${partySyncLabel(syncState, stalledName)}`}>
        {#each faces as mb, i (mb.key)}
            <span class="party-face relative" style:z-index={faces.length - i}>
                <Avatar
                    src={mb.userId ? getAvatarUrl(mb.userId) : ''}
                    alt=""
                    initials={(mb.displayName || 'U').charAt(0).toUpperCase()}
                    username={mb.displayName}
                    size="xs"
                    border={mb.isStalled
                        ? 'border-2 border-warning-500'
                        : 'border-2 border-surface-800'} />
                {#if mb.isHost}
                    <span class="party-crown" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7z" />
                        </svg>
                    </span>
                {/if}
            </span>
        {/each}
        {#if overflow > 0}
            <span
                class="party-face party-more relative inline-flex items-center justify-center rounded-full bg-surface-600 text-[10px] font-semibold text-surface-100 border-2 border-surface-800">
                +{overflow}
            </span>
        {/if}
        <span
            class="party-sync-dot absolute rounded-full ring-2 ring-surface-800 {SYNC_DOT_CLASS[
                syncState
            ]}"
            aria-hidden="true"></span>
    </span>
</Tooltip>

<style>
    .party-face + .party-face {
        margin-left: -0.5rem;
    }

    .party-more {
        width: 1.5rem;
        height: 1.5rem;
    }

    .party-crown {
        position: absolute;
        top: -0.45rem;
        left: 50%;
        transform: translateX(-50%) rotate(-8deg);
        width: 0.75rem;
        height: 0.75rem;
        color: rgb(250 204 21);
        filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.6));
        pointer-events: none;
    }

    .party-crown svg {
        width: 100%;
        height: 100%;
    }

    .party-sync-dot {
        right: -0.1rem;
        bottom: -0.1rem;
        width: 0.55rem;
        height: 0.55rem;
        z-index: 10;
    }
</style>
