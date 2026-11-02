<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import AdminAuditFeed from '$lib/components/admin/AdminAuditFeed.svelte';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import * as m from '$lib/paraglide/messages.js';
</script>

<svelte:head>
    <title>{m.admin_nav_page_system_audit()} - Admin</title>
</svelte:head>

<AdminPageHeader
    title={m.admin_nav_page_system_audit()}
    description={m.admin_nav_desc_system_audit()}
    icon={adminPageIcons['/admin/system/audit-log']} />

<AdminAuditFeed />
