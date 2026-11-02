<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import * as forYouApi from '$lib/api/for-you.js';
    import * as m from '$lib/paraglide/messages.js';
    import { openMediaModal } from '$lib/utils/modal-utils.js';
    import type {
        AudiobookActivityItem,
        AudiobookActivitySection,
    } from '$lib/schemas/api-feed-responses.js';

    /**
     * A server-built section, when the host page already has one.
     *
     * `/audiobooks` builds its own (ungated) section in its `+page.server.ts`
     * so the rail is in the first paint and does not need a post-hydration
     * round trip. For You passes nothing and the rail fetches `/feed` itself,
     * which is where the "has the viewer listened lately" gate lives.
     */
    let { section: provided = null }: { section?: AudiobookActivitySection | null } = $props();

    let fetched = $state<AudiobookActivitySection | null>(null);
    const section = $derived(provided ?? fetched);
    let loadGeneration = 0;

    function dayLabel(occurredOn: string): string {
        const today = new Date();
        const localToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const [year, month, day] = occurredOn.split('-').map(Number);
        const occurred = new Date(year, month - 1, day);
        const days = Math.max(
            0,
            Math.round((localToday.getTime() - occurred.getTime()) / 86400000),
        );
        if (days === 0) return m.audiobook_activity_today();
        if (days === 1) return m.audiobook_activity_yesterday();
        return m.audiobook_activity_days_ago({ days: String(days) });
    }

    function activityLabel(item: AudiobookActivityItem): string {
        if (item.kind === 'finished') return m.audiobook_activity_finished();
        const minutes = item.listenedMinutes ?? 5;
        if (minutes < 60) {
            return m.audiobook_activity_listened_minutes({ minutes: String(minutes) });
        }
        const hours = Math.max(1, Math.round(minutes / 60));
        return m.audiobook_activity_listened_hours({ hours: String(hours) });
    }

    function openBook(item: AudiobookActivityItem): void {
        openMediaModal(
            {
                title: item.media.title,
                mediaType: 'audiobook',
                externalIds: { internal: item.media.catalogId ?? item.media.id },
                isAvailable: true,
                canRequest: false,
            },
            item.media.images.primary?.href ?? '',
        );
    }

    export function refresh(): void {
        // A page that supplies the section owns it; refetching would replace a
        // deliberately ungated section with the gated /feed answer.
        if (provided !== null) return;
        const generation = ++loadGeneration;
        void forYouApi
            .getAudiobookActivityFeed()
            .then(({ data, error }) => {
                if (generation !== loadGeneration || error || !data) return;
                fetched =
                    (data.sections.find((candidate) => candidate.type === 'audiobook-activity') as
                        AudiobookActivitySection | undefined) ?? null;
            })
            .catch(() => {
                // Privacy-preserving failure mode: the optional rail stays absent.
            });
    }

    onMount(() => {
        refresh();
        return () => {
            loadGeneration += 1;
        };
    });
</script>

{#if section && section.items.length > 0}
    <section aria-labelledby="audiobook-activity-title" class="space-y-3">
        <h2 id="audiobook-activity-title" class="text-base font-semibold text-surface-100">
            {section.title}
        </h2>
        <div class="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory scrollbar-thin">
            {#each section.items as item (`${item.author.userId}:${item.media.id}`)}
                <button
                    type="button"
                    class="group relative flex w-64 shrink-0 snap-start items-center gap-3 rounded-xl border border-surface-700 bg-surface-900/70 p-3 text-left transition hover:border-primary-500/60 hover:bg-surface-800"
                    aria-label={`${item.author.displayName ?? ''}: ${item.media.title}`}
                    onclick={() => openBook(item)}>
                    <div class="relative shrink-0">
                        <img
                            src={item.media.images.primary?.variants?.thumb ??
                                item.media.images.primary?.href}
                            alt=""
                            loading="lazy"
                            class="h-20 w-14 rounded-md bg-surface-800 object-cover shadow" />
                        <div
                            class="absolute -bottom-2 -right-2 rounded-full ring-2 ring-surface-900">
                            <Avatar
                                src={item.author.images.primary.variants?.thumb ?? item.author.images.primary.href}
                                username={item.author.displayName ?? ''}
                                alt={item.author.displayName ?? ''}
                                size="2xs" />
                        </div>
                    </div>
                    <div class="min-w-0">
                        <p class="truncate text-sm font-medium text-surface-100">
                            {item.author.displayName ?? ''}
                        </p>
                        <p class="mt-0.5 line-clamp-2 text-sm text-surface-300">
                            {item.media.title}
                        </p>
                        <p class="mt-1 text-xs text-surface-500">
                            {activityLabel(item)} · {item.kind === 'finished'
                                ? dayLabel(item.occurredOn)
                                : m.audiobook_activity_last({ when: dayLabel(item.occurredOn) })}
                        </p>
                    </div>
                </button>
            {/each}
        </div>
    </section>
{/if}
