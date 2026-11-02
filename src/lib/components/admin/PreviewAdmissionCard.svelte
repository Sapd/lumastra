<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Whether hover/scrub previews are being served, why not when they are not, and
  an operator switch to stop them.

  Previews are the first thing a self-hosted box sheds under load — and they
  shed THEMSELVES, via a load circuit and a concurrency budget. So "previews
  stopped working" has three different causes with three different remedies:

    admin_disabled  someone turned them off   → turn them back on, here
    load_shed       the box is too busy       → the load ratio says how busy
    global_budget   every slot is in use      → active/max says how full

  None of that was visible anywhere. The cache page showed preview CACHE
  numbers — size, hit rate, evictions — which describe storage and say nothing
  about admission, so an operator watching a healthy cache had no way to learn
  previews were being refused. `GET|POST /api/admin/previews` has carried the
  admission half since it was written, uncalled.

  The switch is shown as an operator control, not as the current state: when
  the load circuit has shed previews, flipping "off" and back "on" would not
  restore them, and a toggle that appears to control something it does not is
  worse than no toggle. `adminDisabled` drives the switch; `reason` drives what
  the card says.
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { toasts } from '$lib/stores/toast.store';
    import { getPreviewStatus, setPreviewsDisabled } from '$lib/api/admin.js';
    import type { PreviewAdmission } from '$lib/schemas/api-admin-responses.js';

    let admission = $state<PreviewAdmission | null>(null);
    let loading = $state(true);
    let saving = $state(false);
    let loadFailed = $state(false);

    async function load(): Promise<void> {
        loading = true;
        const { data, error } = await getPreviewStatus();
        // Rendering NOTHING on a failure reproduces the exact blind spot this
        // card exists to close: the operator cannot tell "previews are fine"
        // from "the status endpoint is broken", which is how previews went
        // silently off in the first place.
        loadFailed = Boolean(error) || !data;
        admission = data?.admission ?? null;
        loading = false;
    }

    onMount(load);

    async function toggle(): Promise<void> {
        if (!admission || saving) return;
        saving = true;
        const next = !admission.adminDisabled;
        const { data, error } = await setPreviewsDisabled(next);
        saving = false;
        if (error || !data) {
            toasts.error(m.admin_previews_toggle_failed());
            return;
        }
        admission = data.admission;
        toasts.success(next ? m.admin_previews_now_off() : m.admin_previews_now_on());
    }

    /** The sentence that names the actual cause, so the remedy follows from it. */
    function reasonText(a: PreviewAdmission): string {
        if (a.reason === 'admin_disabled') return m.admin_previews_reason_admin();
        if (a.reason === 'load_shed')
            return m.admin_previews_reason_load({
                load: String(Math.round(a.loadRatio * 100)),
                threshold: String(Math.round(a.loadShedRatio * 100)),
            });
        if (a.reason === 'global_budget')
            return m.admin_previews_reason_budget({
                active: String(a.activeCount),
                max: String(a.maxGlobal),
            });
        return m.admin_previews_serving({
            active: String(a.activeCount),
            max: String(a.maxGlobal),
        });
    }
</script>

{#if !loading && loadFailed}
    <div class="rounded-lg border border-surface-700/50 bg-surface-800/40 p-4">
        <h4 class="text-sm font-medium text-surface-200">{m.admin_previews_title()}</h4>
        <p class="text-hint mt-1">{m.admin_previews_unavailable()}</p>
    </div>
{:else if !loading && admission}
    <div class="rounded-lg border border-surface-700/50 bg-surface-800/40 p-4 space-y-2">
        <div class="flex items-center justify-between gap-3">
            <h4 class="text-sm font-medium text-surface-200">{m.admin_previews_title()}</h4>
            <button
                type="button"
                class="btn-secondary text-xs"
                disabled={saving}
                onclick={() => void toggle()}>
                {admission.adminDisabled ? m.admin_previews_turn_on() : m.admin_previews_turn_off()}
            </button>
        </div>

        <p class={admission.disabled ? 'text-sm text-amber-300' : 'text-sm text-surface-300'}>
            {reasonText(admission)}
        </p>

        {#if admission.autoDisabled && !admission.adminDisabled}
            <!--
              The case the switch cannot fix. Saying so stops an operator
              flipping it twice and concluding the button is broken.
            -->
            <p class="text-hint">{m.admin_previews_auto_note()}</p>
        {/if}
    </div>
{/if}
