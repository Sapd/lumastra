<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, Film, ArrowPath } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths.js';
    import { getLibraryStatus } from '$lib/api/integrations.js';
    import type { LibraryStatusResponse } from '$lib/schemas/api-integrations-responses.js';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        isAdmin: boolean;
    }

    let { isAdmin }: Props = $props();

    let status = $state<LibraryStatusResponse | null>(null);
    let pollError = $state(false);

    async function fetchStatus(): Promise<void> {
        try {
            const { data, error } = await getLibraryStatus();
            if (error) {
                pollError = true;
                return;
            }
            status = data;
            pollError = false;
        } catch {
            pollError = true;
        }
    }

    $effect(() => {
        // Fetch immediately on mount.
        void fetchStatus();

        // Poll every 10 seconds, but STOP entirely once scanning is done so we
        // don't poll forever on a long-lived home tab (the hero-state cache can
        // keep this component mounted for up to a minute after completion).
        let interval: ReturnType<typeof setInterval> | null = setInterval(() => {
            if (status !== null && !status.scanning) {
                if (interval !== null) {
                    clearInterval(interval);
                    interval = null;
                }
                return;
            }
            void fetchStatus();
        }, 10_000);

        return () => {
            if (interval !== null) clearInterval(interval);
        };
    });
</script>

<div class="flex items-center justify-center min-h-[550px] lg:min-h-[465px] px-4">
    <div
        class="max-w-lg w-full bg-surface-800/80 backdrop-blur-sm border border-surface-700/60 rounded-2xl p-8 text-center shadow-xl">
        <!-- Icon -->
        <div
            class="w-16 h-16 mx-auto mb-5 rounded-full bg-primary-900/40 flex items-center justify-center">
            {#if status?.scanning}
                <Icon src={ArrowPath} class="w-8 h-8 text-primary-400 animate-spin" />
            {:else}
                <Icon src={Film} class="w-8 h-8 text-primary-400" />
            {/if}
        </div>

        <!-- Heading -->
        <h2 class="text-xl font-semibold text-surface-100 mb-2">{m.library_notice_title()}</h2>

        <!-- Progress line -->
        {#if status !== null && !pollError}
            <p class="text-surface-300 text-sm mb-1" role="status">
                {#if status.mediaWithFiles > 0}
                    {status.mediaWithFiles === 1
                        ? m.library_notice_ready_one({ count: status.mediaWithFiles })
                        : m.library_notice_ready({ count: status.mediaWithFiles })}
                {:else}
                    {m.library_notice_scanning()}
                {/if}
            </p>
        {/if}

        <!-- Explanation -->
        <p class="text-surface-400 text-sm leading-relaxed mt-3">
            {#if isAdmin}
                {m.library_notice_admin_text()}
                <a
                    href={resolve('/admin/library')}
                    class="text-primary-400 hover:text-primary-300 underline underline-offset-2 transition-colors">
                    {m.library_notice_admin_link()}
                </a>
            {:else}
                {m.library_notice_user_text()}
            {/if}
        </p>

        <!-- Stop-polling notice once done (scanning complete but mediaWithFiles still 0) -->
        {#if status !== null && !status.scanning && status.mediaWithFiles === 0 && !pollError}
            <p class="mt-4 text-surface-500 text-xs">
                {m.library_notice_empty()}
            </p>
        {/if}
    </div>
</div>
