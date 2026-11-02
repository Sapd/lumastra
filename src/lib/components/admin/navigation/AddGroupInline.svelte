<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { toasts } from '$lib/stores/toast.store';
    import { normalizeGroupName } from '../../../../routes/api/admin/navigation/groups/group-service';
    import {
        NAV_GROUP_MAX_LENGTH,
        AddNavGroupResponseSchema,
    } from '$lib/schemas/api-admin-navigation';
    import { apiPost } from '$lib/api/client.js';

    interface Props {
        availableGroups: string[];
        onadded: (groups: string[]) => void;
    }

    let { availableGroups, onadded }: Props = $props();

    let value = $state('');
    let pending = $state(false);

    let normalized = $derived(normalizeGroupName(value));
    let isDuplicate = $derived(
        availableGroups.some((g) => g.toLowerCase() === normalized.toLowerCase()),
    );
    let canAdd = $derived(
        normalized.length > 0 &&
            normalized.length <= NAV_GROUP_MAX_LENGTH &&
            !isDuplicate &&
            !pending,
    );

    async function add(): Promise<void> {
        if (!canAdd || pending) return;
        pending = true;
        try {
            const {
                data: json,
                error,
                code,
                status,
            } = await apiPost('/api/admin/navigation/groups', AddNavGroupResponseSchema, {
                group: normalized,
            });
            if (status === 429) {
                toasts.error(m.admin_navigation_add_group_rate_limited());
                return;
            }
            if (error || !json) {
                // `code` is the machine-parseable problem+json code field
                if (code === 'env_locked') toasts.error(m.admin_navigation_add_group_env_locked());
                else if (code === 'invalid') toasts.error(m.admin_navigation_add_group_invalid());
                else if (code === 'limit') toasts.error(m.admin_navigation_add_group_limit());
                else toasts.error(m.admin_navigation_add_group_failed());
                return;
            }
            onadded(json.availableGroups);
            if (json.persisted === false) {
                toasts.success(m.admin_navigation_add_group_saved());
                toasts.warning(m.admin_navigation_add_group_memory_only());
            } else {
                toasts.success(m.admin_navigation_add_group_saved());
            }
            value = '';
        } finally {
            pending = false;
        }
    }

    function onkeydown(e: KeyboardEvent): void {
        if (e.key === 'Enter') {
            e.preventDefault();
            void add();
        }
    }
</script>

<div class="flex items-center gap-2 mt-2">
    <input
        type="text"
        bind:value
        {onkeydown}
        maxlength={NAV_GROUP_MAX_LENGTH}
        placeholder={m.admin_navigation_add_group_placeholder()}
        class="px-2 py-1 text-sm bg-surface-800 border border-surface-600 rounded text-surface-100" />
    <button
        type="button"
        onclick={add}
        disabled={!canAdd}
        class="px-2 py-1 text-sm rounded bg-primary-500 hover:bg-primary-400 text-surface-900 disabled:opacity-50 disabled:cursor-not-allowed">
        + {m.admin_navigation_add_group_button()}
    </button>
    {#if isDuplicate && normalized.length > 0}
        <span class="text-xs text-surface-400">{m.admin_navigation_add_group_exists()}</span>
    {/if}
</div>
