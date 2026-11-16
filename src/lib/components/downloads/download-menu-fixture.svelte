<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only

Test fixture: a modal body with the real "..." ActionPopover, used by
DownloadConfirmSheet.modal.svelte.test.ts.
-->
<script lang="ts">
    import ActionPopover from '$lib/components/modal/ActionPopover.svelte';
</script>

<div data-testid="fixture-modal">
    <button type="button" data-testid="inner-button">inner</button>
    <ActionPopover ariaLabel="More">
        {#snippet trigger()}<span>...</span>{/snippet}
        {#snippet content()}
            <button type="button" role="menuitem" data-testid="menu-item">Download</button>
            <button type="button" role="menuitem" data-testid="menu-item-2">Settings</button>
            <button type="button" role="menuitem" data-testid="menu-item-admin">
                Manage in Admin
            </button>
        {/snippet}
    </ActionPopover>
    <button type="button" data-testid="after-trigger">next control</button>
</div>
