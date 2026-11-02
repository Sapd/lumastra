<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    // Simple mode setup on the viewer's own account (the viewer, or a helper
    // signed in as them). A locked setup asks for the PIN first.
    import { goto, invalidateAll } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { updateSimpleMode, verifySimpleModePin } from '$lib/api/livetv-simple-mode.js';
    import type { LiveTvSimpleModeUpdate } from '$lib/schemas/livetv-simple-mode.js';
    import SimpleModeEditor from '$lib/components/livetv/simple/SimpleModeEditor.svelte';
    import SimplePinPad from '$lib/components/livetv/simple/SimplePinPad.svelte';
    import { pinErrorMessage } from '$lib/components/livetv/simple/pin-errors.js';

    let { data } = $props();

    let pin = $state<string | null>(null);
    let unlocked = $derived(!data.setupMode.locked || pin !== null);

    async function checkPin(candidate: string): Promise<string | null> {
        const result = await verifySimpleModePin(candidate);
        if (result.status === 204) {
            pin = candidate;
            return null;
        }
        return pinErrorMessage(result);
    }

    async function save(update: LiveTvSimpleModeUpdate) {
        const result = await updateSimpleMode(pin ? { ...update, pin } : update);
        // A PIN set or changed here is the one the next save must send.
        if (result.data?.locked && update.newPin) pin = update.newPin;
        return result;
    }
</script>

<svelte:head>
    <title>{m.livetv_simple_setup_title()}</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 pb-16 pt-4 lg:pt-20">
    <a class="text-sm text-primary-300 hover:underline" href={resolve('/livetv')}
        >← {m.livetv_simple_setup_back()}</a>
    <h1 class="mt-3 text-2xl font-bold text-white">{m.livetv_simple_setup_title()}</h1>
    <p class="mt-2 text-surface-300">{m.livetv_simple_setup_intro()}</p>
    <p class="mt-2 text-sm text-surface-400">{m.livetv_simple_setup_remote_hint()}</p>

    {#if unlocked}
        <div class="mt-8">
            <SimpleModeEditor
                mode={data.setupMode}
                channels={data.channels}
                {save}
                onsaved={(saved) => {
                    // A lock removed here means the next save needs no PIN.
                    if (!saved.locked) pin = null;
                    void invalidateAll();
                }} />
        </div>
    {:else}
        <SimplePinPad
            title={m.livetv_simple_pin_title()}
            onsubmit={checkPin}
            oncancel={() => void goto(resolve('/livetv'))} />
    {/if}
</div>
