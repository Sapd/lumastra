<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { page } from '$app/stores';
    import { AdminSettingsPage } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import AiDiagnosticsPanel from '$lib/components/admin/ai/AiDiagnosticsPanel.svelte';
    import ProviderCategorySection from '$lib/components/admin/providers/ProviderCategorySection.svelte';
    import { resolve } from '$lib/paths';
    import { Icon, ArrowRight, CpuChip, type IconSource } from 'svelte-hero-icons';
    import type { PageData, ActionData } from './$types';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        data: PageData;
        form: ActionData;
    }

    let { data, form }: Props = $props();

    const cardClass =
        'group flex flex-col gap-2 rounded-lg border border-surface-700 bg-surface-800/50 p-4 transition-colors hover:border-cyan-500/50 hover:bg-surface-800';

    // Admin IA redesign (spec §3.7): these dashboards moved under Developer
    // (devOnly) — their routes now 404 for non-dev admins via
    // requireDevTools(), so only surface the card (and its outbound links)
    // when Developer tools are enabled. Operators trigger the same backfills
    // from Tasks → Overview instead.
    let devToolsEnabled = $derived($page.data.devToolsEnabled === true);
</script>

<!--
  AI coverage dashboards — friendly per-domain views that live outside the
  settings schema. Surfaced here so the AI admin page is the one obvious place
  to find them (they're otherwise only reachable by URL / nav-pinning) when
  Developer tools are on. hrefs are literal resolve() calls per project
  convention (typed-routes lint).
-->
{#snippet toolBody(icon: IconSource, title: string, description: string)}
    <div class="flex items-center gap-2">
        <Icon src={icon} class="w-5 h-5 text-cyan-400" />
        <span class="font-medium text-white">{title}</span>
        <Icon
            src={ArrowRight}
            class="w-4 h-4 ml-auto text-surface-500 transition-transform group-hover:translate-x-0.5 group-hover:text-cyan-400" />
    </div>
    <p class="text-sm text-surface-400">{description}</p>
{/snippet}

<svelte:head>
    <title>{m.admin_ai_page_title()}</title>
</svelte:head>

<AdminSettingsPage
    {data}
    {form}
    icon={adminPageIcons['/admin/settings/ai']}
    heading="AI"
    description={m.admin_ai_description()}>
    {#snippet beforeSections()}
        {#if data.aiProviders.length > 0}
            <div class="mb-6">
                <ProviderCategorySection
                    title={m.providers_section_ai_services()}
                    description={m.providers_desc_ai_services()}
                    icon={CpuChip}
                    iconClass="text-purple-400"
                    providers={data.aiProviders}
                    checkableIds={new Set(data.aiCheckableIds)} />
            </div>
        {/if}
    {/snippet}
    {#snippet sectionSnippet({ sectionId })}
        {#if sectionId === 'foryou'}
            <!-- Divider marking the boundary between the two unrelated AI features
                 (Recommendations/Embeddings above, Assistant/Chat below) so the two
                 provider+API-key configs are never mistaken for one another. -->
            <div class="my-6 flex items-center gap-3" role="separator">
                <div class="h-px flex-1 bg-surface-700"></div>
                <span class="text-xs font-medium tracking-wide text-surface-400 uppercase">
                    Separate feature — own provider &amp; API key below
                </span>
                <div class="h-px flex-1 bg-surface-700"></div>
            </div>
        {/if}
    {/snippet}
    {#snippet afterSections()}
        <div class="mt-6">
            <AiDiagnosticsPanel />
        </div>

        {#if devToolsEnabled}
            <div class="card-base mt-6">
                <h3 class="text-lg font-semibold text-white mb-1">AI Coverage Dashboards</h3>
                <p class="text-surface-400 mb-4 text-sm">
                    Friendly per-domain views of embedding coverage, with one-click backfills.
                    Developer tools.
                </p>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <a href={resolve('/admin/developer/embeddings')} class={cardClass}>
                        {@render toolBody(
                            adminPageIcons['/admin/developer/embeddings'],
                            'Embeddings Explorer',
                            'Inspect embedding vectors, data quality, and similarity for any item.',
                        )}
                    </a>
                    <a href={resolve('/admin/developer/vod-embeddings')} class={cardClass}>
                        {@render toolBody(
                            adminPageIcons['/admin/developer/vod-embeddings'],
                            'VOD Embeddings Coverage',
                            'How much of the movie & TV catalog has AI embeddings, with backfill actions.',
                        )}
                    </a>
                    <a href={resolve('/admin/developer/sonic-embeddings')} class={cardClass}>
                        {@render toolBody(
                            adminPageIcons['/admin/developer/sonic-embeddings'],
                            'Sonic Embeddings Coverage',
                            'Audio-similarity embedding coverage for music tracks (MSCLAP).',
                        )}
                    </a>
                </div>
            </div>
        {/if}
    {/snippet}
</AdminSettingsPage>
