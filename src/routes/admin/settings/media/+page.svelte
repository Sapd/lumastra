<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Settings → Media & images. Image optimization and media storage moved off
  the general settings page, which rendered 13 sections at once.
-->
<script lang="ts">
    import { AdminSettingsPage } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import type { PageData, ActionData } from './$types';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        data: PageData;
        form: ActionData;
    }

    let { data, form }: Props = $props();
</script>

<svelte:head>
    <title>{m.admin_nav_page_settings_media()}</title>
</svelte:head>

<AdminSettingsPage
    {data}
    {form}
    icon={adminPageIcons['/admin/settings/media']}
    heading={m.admin_nav_page_settings_media()}
    description={m.admin_nav_desc_settings_media()} />
