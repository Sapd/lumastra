<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { discogsCredits, validDiscogsCatalogueUrl } from '$lib/shared/music-provenance';
    interface Props {
        metadata?: unknown;
        namespace?: 'artist_enrichment' | 'album_enrichment';
        displayed?: Record<string, unknown>;
        sourceUrls?: (string | null | undefined)[];
        inheritedPosterUrl?: string | null;
    }
    let {
        metadata,
        namespace = 'artist_enrichment',
        displayed = {},
        inheritedPosterUrl = null,
        sourceUrls = [],
    }: Props = $props();
    const urls = $derived([
        ...new Set([
            ...discogsCredits(metadata, namespace, displayed),
            ...sourceUrls.filter(validDiscogsCatalogueUrl),
            ...(validDiscogsCatalogueUrl(inheritedPosterUrl) ? [inheritedPosterUrl] : []),
        ]),
    ]);
</script>

{#if urls.length > 0}
    <div class="flex flex-wrap gap-2 text-xs text-surface-400">
        {#each urls as url (url)}
            <a
                href={url}
                onclickcapture={(event: MouseEvent) => event.stopPropagation()}
                onkeydowncapture={(event: KeyboardEvent) => {
                    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                }}
                target="_blank"
                rel="noopener noreferrer"
                class="underline hover:text-surface-200">{m.attribution_discogs_data()}</a>
        {/each}
    </div>
{/if}
