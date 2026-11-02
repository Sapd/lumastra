<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { Cog6Tooth } from 'svelte-hero-icons';
    import AdminSettingsPage from '$lib/components/admin/settings/AdminSettingsPage.svelte';
    import { configSchema, configSections } from '$lib/config/schema';
    import { initializeShowAdvancedSettings } from '$lib/stores/admin-show-advanced.store';

    // Mirrors the layout's post-hydration initialization, using real settings
    // markup, schema, section filtering and input components.
    onMount(initializeShowAdvancedSettings);
    let { sectionId = 'branding' }: { sectionId?: string } = $props();
    const sectionIds = $derived(sectionId.split(','));
    const values = Object.fromEntries(
        configSchema.map((setting) => [setting.key, setting.defaultValue]),
    );
</script>

<AdminSettingsPage
    data={{
        values,
        envOverrides: [],
        schema: {
            sections: configSections
                .filter((section) => sectionIds.includes(section.id))
                .map((section) => ({ ...section, order: sectionIds.indexOf(section.id) })),
            settings: configSchema.filter((setting) => sectionIds.includes(setting.section)),
        },
        configPath: '/config/settings.json',
        storageStatus: null,
    }}
    form={null}
    icon={Cog6Tooth}
    heading="Settings hydration"
    description="Real settings markup hydration regression" />
