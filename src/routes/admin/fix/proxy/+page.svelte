<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /admin/fix/proxy — what the reverse proxy actually sends.

  ## This page's own request is the measurement

  When the trusted-proxy list does not contain the real edge, identity headers
  are discarded and every login fails closed — correctly, and completely
  silently. No exception, no failed healthcheck, no log line anyone would think
  to search for. Nothing can detect it from stored state, because the evidence
  only exists during a request. So the operator's own request is the probe: it
  travelled the same path a user's login takes.

  ## Values are shown as presence and length, never as text

  An identity header names a real person, and a header from an untrusted machine
  is text an attacker chose. Presence and length answer both real questions —
  "is it arriving?" and "is it empty?" — with neither hazard, and the page says
  so rather than leaving the omission looking like an oversight.
-->
<script lang="ts">
    import { Icon, ArrowPath, CheckCircle, XCircle, ExclamationTriangle } from 'svelte-hero-icons';
    import FixPageShell from '$lib/components/admin/fix/FixPageShell.svelte';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import { findSymptom } from '$lib/components/admin/fix/symptoms.js';
    import {
        ProxyEchoSchema,
        type ProxyEcho,
    } from '$lib/components/admin/fix/proxy-echo.schema.js';
    import { apiGet } from '$lib/api/client.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import * as m from '$lib/paraglide/messages.js';

    const symptom = findSymptom('proxy');

    let echo = $state<ProxyEcho | null>(null);
    let loading = $state(false);
    let loadError = $state<ClassifiedError | null>(null);

    async function load(): Promise<void> {
        loading = true;
        loadError = null;
        const res = await apiGet('/api/admin/fix/proxy-echo', ProxyEchoSchema, { strict: true });
        loading = false;
        if (res.data) {
            echo = res.data;
        } else if (res.error) {
            loadError = classifyError(new Error(res.error), { status: res.status });
        }
    }

    $effect(() => {
        void load();
    });

    const verdict = $derived.by(() => {
        if (!echo) return null;
        switch (echo.verdict) {
            case 'ok':
                // The chain works; a forgeable trust setting is the separate
                // trustWarning alert shown right under this banner.
                return { text: m.admin_fix_proxy_verdict_ok(), bad: false };
            case 'user-header-unusable':
                return {
                    text: m.admin_fix_proxy_verdict_user_unusable({
                        header: echo.identityHeaders[0]?.name ?? '',
                    }),
                    bad: true,
                };
            case 'forward-auth-disabled':
                return { text: m.admin_fix_proxy_verdict_disabled(), bad: true };
            case 'no-identity-headers':
                return { text: m.admin_fix_proxy_verdict_no_headers(), bad: true };
            case 'identity-from-untrusted-peer':
                return { text: m.admin_fix_proxy_verdict_untrusted(), bad: true };
            default:
                return { text: m.admin_fix_proxy_verdict_failclosed(), bad: true };
        }
    });

    function purposeText(role: ProxyEcho['identityHeaders'][number]['role']): string {
        switch (role) {
            case 'user':
                return m.admin_fix_proxy_purpose_user();
            case 'groups':
                return m.admin_fix_proxy_purpose_groups();
            case 'client-ip':
                return m.admin_fix_proxy_purpose_client_ip();
            case 'proto':
                return m.admin_fix_proxy_purpose_proto();
            case 'forwarded-host':
                return m.admin_fix_proxy_purpose_forwarded_host();
            default:
                return m.admin_fix_proxy_purpose_host();
        }
    }

    const trustWarningText = $derived.by(() => {
        switch (echo?.trustWarning) {
            case 'address-header':
                return m.admin_fix_proxy_trust_warning_address_header();
            case 'trust-any':
                return m.admin_fix_proxy_trust_warning_trust_any();
            case 'wide-range':
                return m.admin_fix_proxy_trust_warning_wide_range();
            default:
                return null;
        }
    });

    const postureText = $derived.by(() => {
        if (!echo) return '';
        switch (echo.posture) {
            case 'allowlist':
                return m.admin_fix_proxy_posture_allowlist();
            case 'trust-any':
                return m.admin_fix_proxy_posture_trustany();
            default:
                return m.admin_fix_proxy_posture_failclosed();
        }
    });
</script>

{#if symptom}
    <FixPageShell title={symptom.title()} icon={symptom.icon}>
        <p class="max-w-3xl text-sm leading-relaxed text-surface-300">
            {m.admin_fix_proxy_intro()}
        </p>

        <div class="flex justify-end">
            <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded border border-surface-700 px-2.5 py-1 text-xs text-surface-300 hover:bg-surface-800 disabled:opacity-50"
                disabled={loading}
                onclick={() => void load()}>
                <Icon src={ArrowPath} class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
                {m.admin_fix_proxy_refresh()}
            </button>
        </div>

        <AsyncSection {loading} error={loadError} onretry={() => void load()}>
            {#if echo && verdict}
                <div class="space-y-6">
                    <div
                        class="flex items-start gap-3 rounded-lg border p-4 {verdict.bad
                            ? 'border-error-700/60 bg-error-900/20'
                            : 'border-success-700/60 bg-success-900/20'}">
                        <Icon
                            src={verdict.bad ? XCircle : CheckCircle}
                            class="mt-0.5 h-5 w-5 shrink-0 {verdict.bad
                                ? 'text-error-300'
                                : 'text-success-300'}" />
                        <p class="text-sm leading-relaxed text-surface-100">{verdict.text}</p>
                    </div>

                    {#if trustWarningText}
                        <div
                            role="alert"
                            class="flex items-start gap-3 rounded-lg border border-error-700/60 bg-error-900/20 p-4">
                            <Icon
                                src={ExclamationTriangle}
                                class="mt-0.5 h-5 w-5 shrink-0 text-error-300" />
                            <p class="text-sm leading-relaxed text-surface-100">
                                {trustWarningText}
                            </p>
                        </div>
                    {/if}

                    <section class="space-y-1">
                        <h2 class="text-sm font-medium text-surface-200">
                            {m.admin_fix_proxy_peer_heading()}
                        </h2>
                        <p class="text-sm text-surface-100">
                            <span class="text-xs text-surface-400"
                                >{m.admin_fix_proxy_peer_label()}:</span>
                            <span class="ml-1 font-mono">{echo.peerAddress}</span>
                            <span
                                class="ml-2 text-xs {echo.peerTrusted
                                    ? 'text-success-300'
                                    : 'text-error-300'}">
                                {echo.peerTrusted
                                    ? m.admin_fix_proxy_trusted_yes()
                                    : m.admin_fix_proxy_trusted_no()}
                            </span>
                        </p>
                        <p class="max-w-3xl text-xs leading-relaxed text-surface-400">
                            {m.admin_fix_proxy_peer_note()}
                        </p>
                        <p class="text-xs text-surface-400">{postureText}</p>
                    </section>

                    {#each [{ heading: m.admin_fix_proxy_identity_heading(), rows: echo.identityHeaders }, { heading: m.admin_fix_proxy_forwarding_heading(), rows: echo.forwardingHeaders }] as group (group.heading)}
                        <section class="space-y-2">
                            <h2 class="text-sm font-medium text-surface-200">{group.heading}</h2>
                            <ul class="divide-y divide-surface-800">
                                {#each group.rows as hdr (hdr.name)}
                                    <li class="flex items-start gap-3 py-2">
                                        <Icon
                                            src={hdr.present ? CheckCircle : XCircle}
                                            class="mt-0.5 h-4 w-4 shrink-0 {hdr.present
                                                ? 'text-success-300'
                                                : 'text-error-300'}" />
                                        <div class="min-w-0">
                                            <p class="font-mono text-xs text-surface-100">
                                                {hdr.name}
                                            </p>
                                            <p class="text-xs text-surface-300">
                                                {hdr.present
                                                    ? m.admin_fix_proxy_arrived({
                                                          length: hdr.length,
                                                      })
                                                    : m.admin_fix_proxy_absent()}
                                            </p>
                                            <p class="text-xs leading-relaxed text-surface-400">
                                                {purposeText(hdr.role)}
                                            </p>
                                        </div>
                                    </li>
                                {/each}
                            </ul>
                        </section>
                    {/each}

                    <p class="max-w-3xl text-xs leading-relaxed text-surface-500">
                        {m.admin_fix_proxy_privacy_note()}
                    </p>
                </div>
            {/if}
        </AsyncSection>
    </FixPageShell>
{/if}
