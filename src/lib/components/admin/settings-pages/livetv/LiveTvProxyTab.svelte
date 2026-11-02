<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Proxy tab content for Settings → Live TV (admin IA redesign, spec §3.6:
  sources/channels/proxy/radio as tabs on ONE page). Ported near-verbatim
  from the deleted standalone `/admin/livetv/proxy` page.
-->
<script lang="ts">
    import { AdminPageHeader } from '$lib/components/admin';
    import { Signal } from 'svelte-hero-icons';
    import ProxyDashboard from '$lib/components/admin/livetv/ProxyDashboard.svelte';
    import type { LiveTvProxyTabData } from '$lib/server/admin/livetv-proxy-data';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        data: LiveTvProxyTabData;
    }

    let { data }: Props = $props();
</script>

<div class="space-y-6">
    <AdminPageHeader
        icon={Signal}
        title={m.admin_livetv_proxy_title()}
        description={m.admin_livetv_proxy_description()} />

    {#if data.liveTvSource !== 'standalone'}
        <div class="bg-surface-800 rounded-lg p-8 text-center">
            <p class="text-surface-400">{m.admin_livetv_proxy_standalone_only()}</p>
            <p class="text-sm text-surface-500 mt-2">
                {m.admin_livetv_current_source()}
                <code class="text-surface-300">{data.liveTvSource}</code>
            </p>
        </div>
    {:else}
        <ProxyDashboard initialStatus={data.proxyStatus} initialError={data.proxyError} />
    {/if}
</div>
