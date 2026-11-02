<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages';
    import { Icon, CodeBracket, DocumentText, ClipboardDocument, Check } from 'svelte-hero-icons';
    import lumastraLogo from '$lib/assets/branding/lumastra-logo-horizontal-ondark.svg';
    import tmdbLogo from '$lib/assets/providers/tmdb.svg';
    import AudiobookshelfAttribution from './AudiobookshelfAttribution.svelte';

    // Version comes from the build (package.json), injected via the server layout.
    const version = $derived($page.data.appVersion ?? 'unknown');
    // The build version is a git-describe string that already starts with "v";
    // the copyright line adds its own, which printed "Lumastra vv0.1.0-…".
    const bareVersion = $derived(String(version).replace(/^v(?=\d)/i, ''));

    const metadataProviders = [
        { id: 'mdblist', name: 'MDBList', url: 'https://mdblist.com/' },
        { id: 'musicbrainz', name: 'MusicBrainz', url: 'https://musicbrainz.org/' },
        { id: 'coverartarchive', name: 'Cover Art Archive', url: 'https://coverartarchive.org/' },
        { id: 'theaudiodb', name: 'TheAudioDB', url: 'https://www.theaudiodb.com/' },
        { id: 'discogs', name: 'Discogs', url: 'https://www.discogs.com/' },
        { id: 'deezer', name: 'Deezer', url: 'https://www.deezer.com/' },
        { id: 'lastfm', name: 'Last.fm', url: 'https://www.last.fm/' },
        { id: 'acoustid', name: 'AcoustID', url: 'https://acoustid.org/' },
        { id: 'lrclib', name: 'LRCLIB', url: 'https://lrclib.net/' },
        { id: 'fribb', name: 'Fribb anime-lists', url: 'https://github.com/Fribb/anime-lists' },
        { id: 'myanimelist', name: 'MyAnimeList', url: 'https://myanimelist.net/' },
        { id: 'trakt', name: 'Trakt', url: 'https://trakt.tv/' },
    ];

    let versionCopied = $state(false);
    async function copyVersion(): Promise<void> {
        try {
            await navigator.clipboard.writeText(`Lumastra ${version}`);
            versionCopied = true;
            setTimeout(() => (versionCopied = false), 2000);
        } catch {
            // Clipboard blocked — the version is on screen to copy by hand.
        }
    }
    // Canonical project repository — the AGPL §13 source offer. Hardcoded on purpose:
    // a fork that modifies and redistributes Lumastra must change this to point
    // at its own corresponding source.
    const repo = 'https://github.com/Sapd/lumastra';
    const licensingUrl = `${repo}/blob/HEAD/LICENSING.md`;
</script>

<div class="text-center mb-5">
    <!-- Fixed Lumastra logo (independent of operator branding). -->
    <!-- The logo already reads "Lumastra"; the heading stays for screen readers. -->
    <img src={lumastraLogo} alt="" class="mx-auto h-16 w-auto" />
    <h2 class="sr-only">Lumastra</h2>
    <p class="mt-3 text-sm text-surface-400 inline-flex items-center gap-1.5">
        {m.settings_about_version_label({ version })}
        <button
            type="button"
            class="btn-icon w-8 h-8 variant-ghost-surface"
            aria-label={m.settings_about_copy_version()}
            title={m.settings_about_copy_version()}
            onclick={copyVersion}>
            <Icon src={versionCopied ? Check : ClipboardDocument} class="w-4 h-4" />
        </button>
    </p>
</div>

<div class="space-y-4 text-sm leading-relaxed">
    <section>
        <h3 class="mb-1 font-semibold">{m.settings_about_heading()}</h3>
        <p class="text-surface-300">
            {m.settings_about_description_part1()}
            <code>/j</code>
            {m.settings_about_description_part2()}
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
            <a
                class="btn btn-sm variant-filled-surface"
                href={repo}
                target="_blank"
                rel="noopener noreferrer">
                <Icon src={CodeBracket} class="h-4 w-4" />
                <span>{m.settings_about_source_code()}</span>
            </a>
            <a
                class="btn btn-sm variant-ghost-surface"
                href={licensingUrl}
                target="_blank"
                rel="noopener noreferrer">
                <Icon src={DocumentText} class="h-4 w-4" />
                <span>{m.settings_about_licensing_notices()}</span>
            </a>
        </div>
    </section>

    <section class="space-y-1 text-xs text-surface-400">
        <p>{m.settings_about_third_party_notice()}</p>
        {#if $page.data.metadataAttributionProviders?.includes('tmdb')}
            <p class="flex items-center gap-2">
                <a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer">
                    <img src={tmdbLogo} alt="TMDB" class="h-3 w-auto shrink-0" />
                </a>
                <span>{m.settings_about_tmdb_attribution()}</span>
            </p>
        {/if}
        {#each metadataProviders.filter( (provider) => $page.data.metadataAttributionProviders?.includes(provider.id) ) as provider (provider.id)}
            <p>
                <a
                    href={provider.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline underline-offset-2 hover:text-surface-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-400">
                    {m.settings_about_provider_attribution({ provider: provider.name })}
                </a>
                {#if provider.id === 'musicbrainz'}
                    <a
                        href="https://musicbrainz.org/doc/About/Data_License"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="underline underline-offset-2 hover:text-surface-200">
                        {m.settings_about_musicbrainz_licence()}
                    </a>
                {/if}
            </p>
        {/each}
        {#if $page.data.activeLibraryTypes?.includes('audiobook')}
            <div><AudiobookshelfAttribution /></div>
        {/if}
        <p>
            <a
                href="https://github.com/altqx/akarisub"
                target="_blank"
                rel="noopener noreferrer"
                class="underline underline-offset-2 hover:text-surface-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-400">
                {m.settings_about_akarisub_attribution()}
            </a>
        </p>
        <p>
            <a
                href="https://github.com/altqx/libbitsub"
                target="_blank"
                rel="noopener noreferrer"
                class="underline underline-offset-2 hover:text-surface-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-400">
                {m.settings_about_libbitsub_attribution()}
            </a>
        </p>
        <p>{m.settings_about_trademark_notice()}</p>
        <p>{m.settings_about_copyright({ version: bareVersion })}</p>
    </section>
</div>
