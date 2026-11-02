<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Compact license status for Settings → General → Licensing, rendered beside
  the key field so an operator can see whether the key they pasted verified
  and what it unlocks. The full panel (install ID, seats, notices) stays on
  /admin/system/instance; this links there rather than duplicating it.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import { resolve } from '$lib/paths';
    import { LICENSE_MODULE_LABELS, type LicenseModule } from '$lib/shared/license-modules.js';
    import { licensePhase, type LicenseStatusSummary } from './license-status-summary';

    interface Props {
        status: LicenseStatusSummary | null;
    }
    let { status }: Props = $props();

    const phase = $derived(status ? licensePhase(status) : null);
    // Contact with lumastra.org switched off (the setting above this card).
    const contactOff = $derived(status?.serverContact === false && status.enforcementEnabled);

    const badge = $derived.by(() => {
        if (phase === 'early-access' && status?.validity === 'valid') {
            return {
                label: m.admin_licensing_early_access(),
                cls: 'border-emerald-500/40 text-emerald-300',
            };
        }
        switch (status?.validity) {
            case 'grace':
                return {
                    label: m.admin_licensing_grace(),
                    cls: 'border-amber-500/40 text-amber-300',
                };
            case 'valid':
                return {
                    label: m.admin_licensing_valid(),
                    cls: 'border-emerald-500/40 text-emerald-300',
                };
            case 'expiring-soon':
                return {
                    label: m.admin_licensing_expiring_soon(),
                    cls: 'border-amber-500/40 text-amber-300',
                };
            case 'expired':
                return {
                    label: m.admin_licensing_expired(),
                    cls: 'border-red-500/40 text-red-300',
                };
            case 'free-tier':
                return {
                    label: m.admin_licensing_free_tier(),
                    cls: 'border-surface-600 text-surface-300',
                };
            default:
                return {
                    label: m.admin_licensing_enforcement_off(),
                    cls: 'border-surface-600 text-surface-300',
                };
        }
    });

    const editionLabel = $derived.by(() => {
        switch (status?.edition) {
            case 'pro':
                return 'Pro';
            case 'enterprise':
                return 'Enterprise';
            case 'unlimited':
                return 'Unlimited';
            default:
                return 'Community (Free)';
        }
    });

    const moduleLabels = $derived(
        (status?.modules ?? []).map((id) => LICENSE_MODULE_LABELS[id as LicenseModule] ?? id),
    );
    const expiresLabel = $derived(
        status?.expiresAt
            ? new Date(status.expiresAt).toLocaleDateString(getLocale(), { timeZone: 'UTC' })
            : null,
    );
</script>

<div
    class="mt-4 rounded-lg border border-surface-700/60 bg-surface-800/30 p-4 text-sm"
    data-testid="license-status-card">
    <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium text-surface-200">{m.admin_licensing_status_title()}</span>
        {#if status}
            <span class="rounded border px-1.5 py-0.5 text-xs {badge.cls}">{badge.label}</span>
            <span class="text-surface-400">· {editionLabel}</span>
            {#if expiresLabel && (phase === 'licensed' || phase === 'early-access')}
                <span class="text-surface-400"
                    >· {m.admin_settings_license_expires({ date: expiresLabel })}</span>
            {/if}
        {:else}
            <span class="text-surface-400">{m.admin_settings_license_unavailable()}</span>
        {/if}
    </div>
    {#if status && phase}
        <p class="mt-2 text-surface-300" data-testid="license-phase">
            {#if phase === 'grace'}
                {expiresLabel
                    ? m.admin_licensing_phase_grace({ date: expiresLabel })
                    : m.admin_licensing_phase_grace_no_date()}
            {:else if phase === 'early-access'}
                {m.admin_licensing_phase_early_access({ date: expiresLabel ?? '—' })}
            {:else if phase === 'free-tier'}
                {m.admin_licensing_phase_free()}
            {:else if phase === 'unrestricted'}
                {m.admin_licensing_phase_unrestricted()}
            {/if}
        </p>
    {/if}
    {#if contactOff}
        <p class="mt-2 text-surface-300" data-testid="license-contact-off">
            {phase === 'free-tier'
                ? m.admin_licensing_contact_off()
                : m.admin_licensing_contact_off_key({ date: expiresLabel ?? '—' })}
            {m.admin_licensing_contact_off_losses()}
        </p>
    {/if}
    {#if status}
        <p class="mt-2 text-surface-400">
            {#if moduleLabels.length > 0}
                {m.admin_settings_license_unlocks({ modules: moduleLabels.join(', ') })}
            {:else}
                {m.admin_settings_license_no_modules()}
            {/if}
        </p>
    {/if}
    <a
        href={resolve('/admin/system/instance') + '#license-status'}
        class="mt-2 inline-block text-primary-300 hover:text-primary-200"
        >{m.admin_settings_license_details()}</a>
</div>
