<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  The station's channel number in a Channel Management row. Click to type a
  number: it is pinned (renumbering and freeing hidden numbers leave it
  alone); the pin button hands it back to automatic numbering. All feeds of a
  backup group share one number.
-->
<script lang="ts">
    import type { AdminChannel } from '$lib/schemas/livetv.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        channel: AdminChannel;
        disabled?: boolean;
        onSave: (channelId: string, number: number) => Promise<unknown>;
        onUnpin: (channelId: string) => Promise<unknown>;
    }

    let { channel, disabled = false, onSave, onUnpin }: Props = $props();

    let editing = $state(false);
    let value = $state('');
    let saving = $state(false);

    function autoFocus(node: HTMLInputElement): void {
        node.focus();
        node.select();
    }

    function startEdit(e: Event): void {
        e.stopPropagation();
        if (disabled) return;
        value = channel.channelNumber === undefined ? '' : String(channel.channelNumber);
        editing = true;
    }

    async function save(): Promise<void> {
        if (!editing || saving) return;
        const number = Number(value.trim());
        if (
            value.trim() === '' ||
            !Number.isInteger(number) ||
            number < 1 ||
            number > 9999 ||
            (number === channel.channelNumber && channel.channelNumberPinned)
        ) {
            editing = false;
            return;
        }
        saving = true;
        try {
            await onSave(channel.id, number);
        } finally {
            saving = false;
            editing = false;
        }
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
            editing = false;
        }
    }

    function unpin(e: Event): void {
        e.stopPropagation();
        void onUnpin(channel.id);
    }
</script>

<span class="inline-flex items-center shrink-0 mr-2" data-testid="channel-number">
    {#if editing}
        <input
            type="text"
            inputmode="numeric"
            maxlength="4"
            bind:value
            onblur={save}
            onkeydown={handleKeydown}
            onclick={(e) => e.stopPropagation()}
            disabled={saving}
            aria-label={m.admin_livetv_number_edit()}
            class="w-14 bg-surface-700 border border-surface-600 rounded px-1.5 py-0.5 text-white text-xs tabular-nums focus:outline-none focus:border-yellow-500"
            use:autoFocus />
    {:else}
        <button
            type="button"
            class="min-w-[2.5rem] px-1.5 py-0.5 rounded text-xs tabular-nums text-left border {channel.channelNumberPinned
                ? 'border-yellow-600/60 text-yellow-300'
                : 'border-surface-600 text-surface-300'} {disabled
                ? ''
                : 'hover:ring-1 hover:ring-surface-500'}"
            title={channel.channelNumberPinned
                ? m.admin_livetv_number_pinned_hint()
                : m.admin_livetv_number_auto_hint()}
            aria-label={m.admin_livetv_number_edit()}
            onclick={startEdit}>
            {channel.channelNumber ?? '–'}
        </button>
        {#if channel.channelNumberPinned && !disabled}
            <button
                type="button"
                class="ml-0.5 px-1 text-[10px] text-surface-500 hover:text-surface-200"
                title={m.admin_livetv_number_unpin()}
                aria-label={m.admin_livetv_number_unpin()}
                onclick={unpin}>
                📌
            </button>
        {/if}
    {/if}
</span>
