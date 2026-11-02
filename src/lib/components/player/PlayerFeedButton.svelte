<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Live TV player: "Feed" — watch another feed of this station (its backup
  group) when the one playing shows the provider's placeholder or stutters.
  Asks the server for the station's feeds once per channel and stays hidden
  when there is nothing to choose: a single feed, or the administrator turned
  feed choice off (the endpoint answers 403).
-->
<script lang="ts" module>
    /** The server said feed choice is off (403); a page reload asks again. */
    let feedChoiceOff = false;
</script>

<script lang="ts">
    import { untrack } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import PlayerFeedMenu from './PlayerFeedMenu.svelte';
    import { setPreferredFeed, getPreferredFeed } from '$lib/components/livetv/feed-preference.js';
    import { getStationFeeds } from '$lib/api/livetv-playback.js';
    import type { LiveTvFeed } from '$lib/schemas/livetv.js';

    interface Props {
        /** The stable station playing. */
        channelId: string;
        isOpen?: boolean;
        onopen?: () => void;
        feedId?: string;
        /** Station name for the menu heading. */
        name: string;
        /** Start a new playback session with another feed. */
        onselectfeed: (feedId: string) => void;
    }

    let {
        channelId,
        feedId,
        name,
        onselectfeed,
        isOpen = $bindable(false),
        onopen,
    }: Props = $props();

    let feeds = $state.raw<LiveTvFeed[]>([]);
    let stationId = $state<string | undefined>();
    let currentFeedId = $state<string | undefined>();
    let feedsLoadedAt = 0;
    let buttonEl = $state<HTMLButtonElement | null>(null);

    $effect(() => {
        const id = channelId;
        untrack(() => {
            feeds = [];
            isOpen = false;
            // Feed choice is off: don't ask again on every channel switch.
            if (feedChoiceOff) return;
            currentFeedId = undefined;
            void loadFeeds(id);
        });
    });

    async function loadFeeds(id: string): Promise<void> {
        const result = await getStationFeeds(id);
        if (result.status === 403) feedChoiceOff = true;
        if (id !== channelId) return;
        if (!result.data) {
            if (result.status === 403) {
                feeds = [];
                isOpen = false;
            }
            return;
        }
        feeds = result.data.feeds;
        stationId = result.data.stationId;
        currentFeedId =
            feedId ??
            currentFeedId ??
            getPreferredFeed(id) ??
            feeds.find((feed) => feed.isDefault)?.id;
        feedsLoadedAt = Date.now();
        if (feeds.length < 2) isOpen = false;
    }

    function toggle(): void {
        if (isOpen) {
            isOpen = false;
            return;
        }
        onopen?.();
        isOpen = true;
        if (Date.now() - feedsLoadedAt >= 60_000) void loadFeeds(channelId);
    }

    function pick(feed: LiveTvFeed, stationId: string | undefined): void {
        isOpen = false;
        buttonEl?.focus();
        setPreferredFeed(stationId, feed.id, feed.isDefault);
        if (feed.id !== (feedId ?? currentFeedId)) {
            if (!feedId) currentFeedId = feed.id;
            onselectfeed(feed.id);
        }
    }
</script>

{#if feeds.length > 1}
    <Tooltip text={m.livetv_feed_choose()} position="top" fixed>
        <button
            bind:this={buttonEl}
            type="button"
            class="control-button"
            class:active={isOpen}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            aria-label={m.livetv_feed_choose_named({ name })}
            onclick={toggle}>
            <!-- Stacked layers: one station, several feeds. -->
            <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24" aria-hidden="true">
                <path
                    d="M12 2 1 7.5l11 5.5 11-5.5L12 2zm0 13.2L3.4 10.9 1 12.1l11 5.5 11-5.5-2.4-1.2L12 15.2zm0 4.6-8.6-4.3L1 16.7l11 5.5 11-5.5-2.4-1.2-8.6 4.3z" />
            </svg>
        </button>
    </Tooltip>
    {#if isOpen}
        <PlayerFeedMenu
            {feeds}
            {name}
            currentId={feedId ?? currentFeedId}
            onpick={(feed) => pick(feed, stationId)}
            onclose={() => {
                isOpen = false;
                buttonEl?.focus();
            }} />
    {/if}
{/if}

<style>
    /* This component owns its button: PlayerControls' scoped styles do not cross
       the component boundary. Match the other transport buttons. */
    .control-button {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0.5rem;
        border: none;
        border-radius: 4px;
        background: none;
        color: white;
        cursor: pointer;
        transition: background-color 0.2s;
    }

    .control-button:hover {
        background: rgba(255, 255, 255, 0.1);
    }

    .control-button.active {
        background: rgba(255, 255, 255, 0.2);
    }

    @media (max-width: 640px) {
        .control-button {
            padding: 0.35rem;
        }

        svg {
            width: 22px;
            height: 22px;
        }
    }

    @media (max-width: 920px) and (orientation: landscape) {
        svg {
            width: 20px;
            height: 20px;
        }
    }
</style>
