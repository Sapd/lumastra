<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    // Admin > Users > (user) > Live TV: set up simple mode for someone else,
    // e.g. an older relative. No PIN needed; turning the lock off clears it.
    import * as m from '$lib/paraglide/messages.js';
    import { getLiveTvChannels } from '$lib/api/playback.js';
    import { getUserSimpleMode, updateUserSimpleMode } from '$lib/api/livetv-simple-mode.js';
    import type { LiveTvStation } from '$lib/schemas/livetv.js';
    import type { LiveTvSimpleMode } from '$lib/schemas/livetv-simple-mode.js';
    import SimpleModeEditor from './SimpleModeEditor.svelte';

    interface Props {
        username: string;
    }

    let { username }: Props = $props();

    let mode = $state<LiveTvSimpleMode | null>(null);
    let channels = $state<LiveTvStation[]>([]);
    let error = $state<string | null>(null);
    let loading = $state(true);

    async function load(name: string): Promise<void> {
        loading = true;
        error = null;
        const [modeResult, lineupResult] = await Promise.all([
            getUserSimpleMode(name),
            getLiveTvChannels(),
        ]);
        if (name !== username) return;
        loading = false;
        if (!modeResult.data) {
            error = modeResult.error ?? m.livetv_simple_setup_failed();
            return;
        }
        if (!lineupResult.data) {
            error = m.livetv_simple_admin_no_lineup();
            return;
        }
        channels = lineupResult.data.items.filter((c) => c.isVisible);
        mode = modeResult.data;
    }

    $effect(() => {
        void load(username);
    });
</script>

<section class="space-y-4 p-5 sm:p-7">
    <div>
        <h3 class="text-base font-semibold text-white">{m.livetv_simple_admin_title()}</h3>
        <p class="mt-1 text-sm text-surface-400">
            {m.livetv_simple_admin_body({ name: username })}
        </p>
    </div>
    {#if loading}
        <p class="text-sm text-surface-400" role="status">{m.livetv_simple_admin_loading()}</p>
    {:else if error}
        <p class="text-sm text-red-300" role="alert">{error}</p>
    {:else if mode}
        {#key username}
            <SimpleModeEditor
                {mode}
                {channels}
                asAdmin
                forUser={username}
                save={(update) => updateUserSimpleMode(username, update)}
                onsaved={(saved) => (mode = saved)} />
        {/key}
    {/if}
</section>
