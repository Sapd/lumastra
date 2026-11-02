<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { page } from '$app/state';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import DisplaySection from '$lib/components/settings/DisplaySection.svelte';
    import SettingsGroup from '$lib/components/settings/SettingsGroup.svelte';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();

    // Live TV simple mode (large, calm Live TV screen) is set up on its own page.
    let liveTv = $derived(
        page.data?.features?.liveTV === true && page.data?.user?.hasLiveTvPermission === true,
    );
</script>

<DisplaySection metadataLanguages={data.metadataLanguages} />

{#if liveTv}
    <SettingsGroup
        label={m.livetv_simple_settings_group()}
        description={m.livetv_simple_settings_body()}>
        <a
            href={resolve('/livetv/simple-setup')}
            class="inline-flex min-h-11 items-center rounded-lg bg-surface-700 px-4 font-medium text-white hover:bg-surface-600"
            >{m.livetv_simple_settings_open()}</a>
    </SettingsGroup>
{/if}
