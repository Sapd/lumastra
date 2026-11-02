<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { z } from 'zod';
    import { Icon, ArrowPath, CheckCircle, XCircle } from 'svelte-hero-icons';
    import { apiGet } from '$lib/api/client.js';

    const OidcProbeSchema = z.object({
        ok: z.boolean(),
        error: z.string().optional(),
        insecure: z.boolean(),
        requestedScopes: z.array(z.string()),
        issuer: z.string().optional(),
        endpoints: z
            .object({
                authorization: z.string().optional(),
                token: z.string().optional(),
                userinfo: z.string().optional(),
                jwks: z.string().optional(),
                endSession: z.string().optional(),
            })
            .optional(),
        scopesSupported: z.array(z.string()).optional(),
        missingScopes: z.array(z.string()).optional(),
        supportsPkceS256: z.boolean().optional(),
        supportsBackchannelLogout: z.boolean().optional(),
        groupsClaim: z.string().optional(),
        claimsSupported: z.array(z.string()).optional(),
        groupsClaimAdvertised: z.boolean().optional(),
        emailAdvertised: z.boolean().optional(),
        preferredUsernameAdvertised: z.boolean().optional(),
    });

    type OidcProbe = z.infer<typeof OidcProbeSchema>;

    let loading = $state(false);
    let result = $state<OidcProbe | null>(null);
    let error = $state<string | null>(null);

    async function testOidc(): Promise<void> {
        loading = true;
        error = null;
        const response = await apiGet('/api/admin/auth/oidc-test', OidcProbeSchema, {
            timeout: 20_000,
        });
        loading = false;
        if (response.error || !response.data) {
            error = response.error ?? 'OIDC probe failed.';
            result = null;
            return;
        }
        result = response.data;
    }
</script>

<section class="card-bordered p-4 space-y-3">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
            <h3 class="text-sm font-semibold text-surface-100">Authentication diagnostics</h3>
            <p class="mt-1 text-xs text-surface-500">
                Tests the saved OIDC discovery settings used by the login flow.
            </p>
        </div>
        <button
            type="button"
            class="btn btn-secondary btn-sm inline-flex items-center gap-1"
            onclick={testOidc}
            disabled={loading}>
            <Icon src={ArrowPath} class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
            <span>Test OIDC</span>
        </button>
    </div>

    {#if error}
        <div class="rounded border border-red-800/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
        </div>
    {:else if result}
        <div
            class="rounded border px-3 py-2 text-sm {result.ok
                ? 'border-green-800/60 bg-green-950/30 text-green-200'
                : 'border-red-800/60 bg-red-950/40 text-red-300'}">
            <div class="flex items-center gap-2 font-medium">
                <Icon src={result.ok ? CheckCircle : XCircle} class="h-4 w-4" />
                {result.ok ? 'OIDC discovery reachable' : result.error}
            </div>
            {#if result.ok}
                <div class="mt-2 grid gap-1 text-xs text-surface-300 md:grid-cols-2">
                    <div>Issuer: <span class="font-mono">{result.issuer}</span></div>
                    <div>Groups claim: <span class="font-mono">{result.groupsClaim}</span></div>
                    <div>
                        PKCE S256:
                        <span
                            >{result.supportsPkceS256 === false
                                ? 'not advertised'
                                : 'ok/unknown'}</span>
                    </div>
                    <div>
                        Missing scopes:
                        <span
                            >{result.missingScopes?.length
                                ? result.missingScopes.join(', ')
                                : 'none'}</span>
                    </div>
                </div>
            {/if}
        </div>
    {/if}
</section>
