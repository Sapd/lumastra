<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { Icon, Key } from 'svelte-hero-icons';
    import { modals } from '$lib/stores/modal.store';
    import ChangePasswordModal from '$lib/components/auth/ChangePasswordModal.svelte';
    import * as m from '$lib/paraglide/messages';
</script>

<div class="between py-3 px-4 gap-4">
    <div class="flex items-center gap-2">
        <Icon src={Key} class="w-4 h-4 text-surface-400" />
        <span class="text-sm">{m.settings_password_change_label()}</span>
    </div>
    <button
        class="btn btn-sm variant-filled-surface"
        onclick={() => modals.open(ChangePasswordModal, {})}>
        {m.settings_password_change_button()}
    </button>
</div>
