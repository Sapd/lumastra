<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Settings → Task runner. The `advanced-tasks` section moved off the general
  settings page; the operator-facing task screens live under /admin/tasks.
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
    <title>{m.admin_nav_page_settings_tasks()}</title>
</svelte:head>

<AdminSettingsPage
    {data}
    {form}
    icon={adminPageIcons['/admin/settings/tasks']}
    heading={m.admin_nav_page_settings_tasks()}
    description={m.admin_nav_desc_settings_tasks()} />
