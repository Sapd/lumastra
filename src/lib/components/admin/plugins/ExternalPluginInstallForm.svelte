<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Collapsible install form for the admin Extensions page. Forwards ONLY
  {manifestUrl, signature, checksum?, force?} to the installer (which does all
  fetch/crypto/SSRF work) — this component performs no crypto and no fetch of its
  own, and exposes NO trusted-key or gate-flag field (trust invariant #1). When
  install is unavailable it renders a read-only info state naming the ENV config;
  the server gate is authoritative regardless of the disabled UI.

  "Check first" runs the server's dry-run (POST .../external/preview): it fetches
  and verifies the MANIFEST only, and reports the host's verdict — which trusted
  key actually matched, the real ABI, whether this replaces an installed version,
  and whether the install would be refused. Everything shown is the host's
  finding, never the manifest's claim; echoing the manifest back would look like
  verification while confirming nothing.

  The preview is deliberately advisory, not a gate. Requiring it before Install
  would train operators to click through it, and the install path re-runs every
  check server-side anyway. It is also cleared whenever the URL or signature
  changes, so a stale verdict can never sit above a different manifest.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { toasts } from '$lib/stores/toast.store';
    import { installExternalPlugin, previewExternalPlugin } from '$lib/api/admin.js';
    import type { ExternalPluginPreview } from '$lib/schemas/api-external-plugins.js';

    let {
        installEnabled,
        trustedKeysConfigured,
        onchanged,
    }: { installEnabled: boolean; trustedKeysConfigured: boolean; onchanged: () => void } =
        $props();

    let available = $derived(installEnabled && trustedKeysConfigured);

    let open = $state(false);
    let manifestUrl = $state('');
    let signature = $state('');
    let checksum = $state('');
    let showAdvanced = $state(false);
    let force = $state(false);
    let confirmingForce = $state(false);
    let submitting = $state(false);
    let previewing = $state(false);
    let preview = $state<ExternalPluginPreview | null>(null);

    /**
     * A verdict belongs to the exact manifest+signature it was computed for.
     * Clearing on ANY edit is what stops "verified by the official key" sitting
     * above a URL the operator has since changed.
     */
    function invalidatePreview(): void {
        preview = null;
    }

    /**
     * Unchecking Force must also drop the confirm step. Otherwise the operator
     * unchecks the box while "Confirm force install" is on screen, the gate
     * (`force && !confirmingForce`) is already satisfied, and the request goes
     * WITHOUT force — a button whose label promises one thing and sends
     * another.
     */
    function onForceChanged(): void {
        if (!force) confirmingForce = false;
    }

    async function runPreview(): Promise<void> {
        if (previewing || !canSubmit) return;
        previewing = true;
        preview = null;
        const checked = { manifestUrl: manifestUrl.trim(), signature: signature.trim() };
        const { data, error } = await previewExternalPlugin(checked);
        previewing = false;
        // Edited while the check ran: this verdict is for another manifest.
        if (manifestUrl.trim() !== checked.manifestUrl || signature.trim() !== checked.signature) {
            return;
        }
        if (error) {
            toasts.error(error);
            return;
        }
        preview = data ?? null;
    }

    let canSubmit = $derived(
        available && manifestUrl.trim().length > 0 && signature.trim().length > 0,
    );

    async function submit(): Promise<void> {
        if (submitting || !canSubmit) return;
        // Force reopens anti-rollback → require an explicit confirm (symmetry with Uninstall).
        if (force && !confirmingForce) {
            confirmingForce = true;
            return;
        }
        confirmingForce = false;
        submitting = true;
        const body = {
            manifestUrl: manifestUrl.trim(),
            signature: signature.trim(),
            ...(checksum.trim() ? { checksum: checksum.trim() } : {}),
            ...(force ? { force: true } : {}),
        };
        const { data, error } = await installExternalPlugin(body);
        submitting = false;
        if (error) {
            toasts.error(error);
            return;
        }
        if (data && 'error' in data && data.error) {
            toasts.error(data.error);
            return;
        }
        if (data && 'restartRequired' in data && data.restartRequired) {
            toasts.info(m.plugins_external_upgrade_staged());
        } else {
            toasts.success(m.plugins_external_installed_loaded());
        }
        manifestUrl = '';
        signature = '';
        checksum = '';
        force = false;
        showAdvanced = false;
        preview = null;
        onchanged();
    }
</script>

{#if !available}
    <div class="section-info">
        <h4 class="text-sm font-medium text-cyan-300 mb-2">
            {m.plugins_external_install_disabled_title()}
        </h4>
        <p class="text-hint">{m.plugins_external_install_disabled_desc()}</p>
    </div>
{:else}
    <div class="card-base space-y-3">
        <button
            type="button"
            class="btn-secondary text-sm"
            aria-expanded={open}
            onclick={() => (open = !open)}>
            {m.plugins_external_install_toggle()}
        </button>

        {#if open}
            <div class="space-y-3">
                <label class="block">
                    <span class="text-sm text-surface-300">
                        {m.plugins_external_install_manifest_label()}
                    </span>
                    <input
                        type="url"
                        class="input mt-1 w-full"
                        bind:value={manifestUrl}
                        oninput={invalidatePreview}
                        placeholder="https://…/manifest.json" />
                </label>

                <label class="block">
                    <span class="text-sm text-surface-300">
                        {m.plugins_external_install_signature_label()}
                    </span>
                    <textarea
                        class="input mt-1 w-full font-mono text-xs"
                        rows="3"
                        bind:value={signature}
                        oninput={invalidatePreview}></textarea>
                </label>

                <label class="block">
                    <span class="text-sm text-surface-300">
                        {m.plugins_external_install_checksum_label()}
                    </span>
                    <input
                        type="text"
                        class="input mt-1 w-full font-mono text-xs"
                        bind:value={checksum} />
                </label>

                <button
                    type="button"
                    class="text-xs text-surface-400 underline"
                    onclick={() => (showAdvanced = !showAdvanced)}>
                    {m.plugins_external_install_advanced()}
                </button>

                {#if showAdvanced}
                    <div class="section-error space-y-2">
                        <label class="flex items-center gap-2 text-sm">
                            <input type="checkbox" bind:checked={force} onchange={onForceChanged} />
                            {m.plugins_external_install_force_label()}
                        </label>
                        <p class="text-hint">{m.plugins_external_install_force_warning()}</p>
                    </div>
                {/if}

                {#if preview}
                    {#if 'error' in preview}
                        <div class="section-error">
                            <p class="text-sm text-red-300">
                                {m.plugins_external_preview_failed({ reason: preview.error })}
                            </p>
                        </div>
                    {:else}
                        <div
                            class={preview.blockedReason
                                ? 'section-error space-y-1'
                                : 'section-info space-y-1'}>
                            <p class="text-sm font-medium text-surface-100">
                                {preview.name} · {preview.version}
                            </p>
                            <p class="text-hint">
                                {preview.signingKeySource === 'official'
                                    ? m.plugins_external_preview_key_official({
                                          keyId: preview.signingKeyId,
                                      })
                                    : m.plugins_external_preview_key_operator({
                                          keyId: preview.signingKeyId,
                                      })}
                            </p>
                            <p class="text-hint">
                                {m.plugins_external_preview_provides({
                                    kinds: preview.kinds.join(', '),
                                    abi: String(preview.sdkAbi),
                                })}
                            </p>
                            {#if preview.installedVersion}
                                <p class="text-hint">
                                    {m.plugins_external_preview_replaces({
                                        installed: preview.installedVersion,
                                    })}
                                </p>
                            {/if}
                            {#if preview.blockedReason}
                                <p class="text-sm text-red-300">
                                    {m.plugins_external_preview_blocked({
                                        reason: preview.blockedReason,
                                    })}
                                </p>
                                {#if force}
                                    <!--
                                      The preview always asks with force:false, so
                                      an operator redeploying their own plugin at
                                      the same or an older version sees a red
                                      "would not install" that Force would in fact
                                      get past. Saying so beats either lying or
                                      teaching them to ignore the verdict.
                                    -->
                                    <p class="text-hint">
                                        {m.plugins_external_preview_force_note()}
                                    </p>
                                {/if}
                            {:else}
                                <p class="text-sm text-emerald-300">
                                    {m.plugins_external_preview_ok()}
                                </p>
                            {/if}
                        </div>
                    {/if}
                {/if}

                {#if confirmingForce}
                    <div class="flex items-center gap-2">
                        <button
                            type="button"
                            class="btn-error text-sm"
                            disabled={submitting}
                            onclick={submit}>
                            {m.plugins_external_install_force_confirm()}
                        </button>
                        <button
                            type="button"
                            class="btn-secondary text-sm"
                            onclick={() => (confirmingForce = false)}>
                            {m.plugins_external_action_cancel()}
                        </button>
                    </div>
                {:else}
                    <div class="flex items-center gap-2">
                        <button
                            type="button"
                            class="btn-secondary text-sm"
                            disabled={!canSubmit || previewing || submitting}
                            onclick={runPreview}>
                            {previewing
                                ? m.plugins_external_preview_checking()
                                : m.plugins_external_preview_submit()}
                        </button>
                        <button
                            type="button"
                            class="btn-primary text-sm"
                            disabled={!canSubmit || submitting}
                            onclick={submit}>
                            {submitting
                                ? m.plugins_external_installing()
                                : m.plugins_external_install_submit()}
                        </button>
                    </div>
                {/if}
            </div>
        {/if}
    </div>
{/if}
