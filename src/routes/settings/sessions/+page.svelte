<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import ActiveStreamsSection from '$lib/components/settings/ActiveStreamsSection.svelte';
    import ControllableDevices from '$lib/components/settings/ControllableDevices.svelte';
    import DeviceHelpersSection from '$lib/components/settings/DeviceHelpersSection.svelte';
    import DevicesSection from '$lib/components/settings/DevicesSection.svelte';
    import JellyfinClientsSection from '$lib/components/settings/JellyfinClientsSection.svelte';
    import WebLoginsSection from '$lib/components/settings/WebLoginsSection.svelte';
    let { data } = $props();
</script>

<!-- The section title comes from the settings layout; every block below is a
     SettingsGroup so this page reads like the others (it used to repeat the
     title and render each list under its own oversized heading). -->
<ActiveStreamsSection viewerUserId={data.viewerUserId} />

{#if data.deviceAuthEnabled}
    <DevicesSection initialSessions={data.deviceSessions.items} />
    <ControllableDevices />
    <DeviceHelpersSection />
{/if}

<!-- Renders itself (heading included) only when /j clients are actually connected. -->
<JellyfinClientsSection />

<WebLoginsSection webLogins={data.webLogins} />
