<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Inline rename for one device.

  Writes `user_devices.custom_name`, which outranks whatever the client reports —
  the heartbeat fires every few minutes and must never undo a name the user chose.
  Clearing the field falls back to the reported name, so the override is undoable
  rather than a one-way door.
-->
<script lang="ts">
    import { Icon, Pencil, ArrowUturnLeft } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        /** Current display name (may be the client-reported one). */
        deviceName: string | null;
        /** True when the current name is a user override, so reset is offered. */
        isCustomName: boolean;
        /** Sessions with no linked device cannot be renamed. */
        canRename: boolean;
        busy?: boolean;
        /**
         * null clears the override. Resolves false when the save failed, so the
         * editor stays open with the typed name intact rather than discarding it.
         */
        onSave: (name: string | null) => Promise<boolean>;
    }
    let { deviceName, isCustomName, canRename, busy = false, onSave }: Props = $props();

    let editing = $state(false);
    let draft = $state('');

    function open(): void {
        draft = deviceName ?? '';
        editing = true;
    }

    /**
     * Select the existing name as soon as the field mounts, so typing replaces it.
     * An attachment rather than bind:this + $effect: it runs on every mount, which
     * is exactly once per open, with no stale-node window to guard against.
     */
    function selectOnMount(node: HTMLInputElement): void {
        node.focus();
        node.select();
    }

    async function save(): Promise<void> {
        const next = draft.trim();
        // An empty field means "stop overriding" rather than "name it nothing" —
        // the server treats null as a clear.
        // Close only on success: a failed save used to close the editor anyway and
        // throw away what the user had typed, leaving them a toast and nothing else.
        if (await onSave(next.length > 0 ? next : null)) editing = false;
    }

    async function reset(): Promise<void> {
        if (await onSave(null)) editing = false;
    }

    function onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Enter') {
            event.preventDefault();
            void save();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            editing = false;
        }
    }
</script>

{#if editing}
    <div class="flex items-center gap-2">
        <input
            {@attach selectOnMount}
            bind:value={draft}
            onkeydown={onKeydown}
            class="input input-sm text-sm max-w-48"
            placeholder={m.settings_devices_rename_placeholder()}
            aria-label={m.settings_devices_rename_placeholder()}
            maxlength={64}
            disabled={busy} />
        <button class="btn btn-sm variant-filled-primary text-xs" onclick={save} disabled={busy}
            >{m.settings_devices_rename_save()}</button>
        {#if isCustomName}
            <button
                class="btn btn-sm variant-soft text-xs"
                onclick={reset}
                disabled={busy}
                title={m.settings_devices_rename_reset()}
                aria-label={m.settings_devices_rename_reset()}>
                <Icon src={ArrowUturnLeft} class="w-4 h-4" />
            </button>
        {/if}
        <button
            class="btn btn-sm variant-soft text-xs"
            onclick={() => (editing = false)}
            disabled={busy}>{m.settings_devices_rename_cancel()}</button>
    </div>
{:else if canRename}
    <button
        class="btn btn-sm variant-soft text-xs"
        onclick={open}
        disabled={busy}
        title={m.settings_devices_rename_label({ name: deviceName ?? '' })}
        aria-label={m.settings_devices_rename_label({ name: deviceName ?? '' })}>
        <Icon src={Pencil} class="w-4 h-4" />
    </button>
{:else}
    <span class="text-xs text-surface-500">{m.settings_devices_rename_unlinked()}</span>
{/if}
