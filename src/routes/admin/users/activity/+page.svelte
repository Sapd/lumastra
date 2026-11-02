<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { AdminPageHeader } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { ActivityFeed } from '$lib/components/activity-feed';
    import * as m from '$lib/paraglide/messages.js';
</script>

<svelte:head>
    <title>{m.admin_nav_page_users_activity()} - Admin</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/users/activity']}
        title={m.admin_nav_page_users_activity()}
        description={m.admin_nav_desc_users_activity()} />

    <ActivityFeed limit={50} />
</div>
