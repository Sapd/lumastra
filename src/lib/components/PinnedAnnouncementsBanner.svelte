<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Homepage-only banner for currently-pinned admin broadcasts.

  Deliberately NOT the same component as `MaintenanceBanner.svelte` — that one is
  `position: fixed` app-shell chrome shown on every route (mirrors a maintenance
  notice, which is time-boxed and needs to follow the user everywhere). This one
  is in-flow homepage content, shown once per pinned announcement, and product
  scope is explicitly homepage-only: an announcement is expected content on `/`,
  not a persistent overlay that would fight for space on `/browse` or `/watch`.

  Rendered in the "below-hero" content band (same place a plugin's own
  below-hero banner widget renders) — directly under the hero + nav buttons,
  above the widget grid (so above Active Streams and everything else in it),
  not above the hero itself. No layout wrapper of its own beyond the flex
  stack below; the caller supplies the horizontal margins to match that band.

  No dismiss control by design — a pinned notification cannot be dismissed by a
  user (`DELETE /api/v1/notifications/{id}` 409s while pinned), so offering a
  close button here would promise something the API refuses. It disappears from
  the homepage the same way it disappears from the drawer: the admin unpins it,
  or it expires.
-->

<script lang="ts">
    import { Icon, Megaphone } from 'svelte-hero-icons';

    interface PinnedAnnouncement {
        id: string;
        title: string;
        body?: string;
    }

    interface Props {
        announcements: PinnedAnnouncement[];
    }

    let { announcements }: Props = $props();
</script>

{#if announcements.length > 0}
    <div class="flex flex-col gap-3" data-testid="pinned-announcements">
        {#each announcements as announcement (announcement.id)}
            <div
                role="status"
                class="flex items-start gap-3 rounded-xl border border-amber-700/60 bg-amber-900/30 px-4 py-3 text-amber-100 backdrop-blur-sm">
                <Icon src={Megaphone} class="mt-0.5 h-5 w-5 shrink-0 text-amber-300" solid />
                <div class="min-w-0">
                    <p class="font-medium leading-snug">{announcement.title}</p>
                    {#if announcement.body}
                        <p class="mt-0.5 text-sm leading-snug text-amber-100/80">
                            {announcement.body}
                        </p>
                    {/if}
                </div>
            </div>
        {/each}
    </div>
{/if}
