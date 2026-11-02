<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin IA redesign, spec §6: a direct hit on a task's own URL always renders
  page mode — the SAME `TaskDetail` component the list page shows as a
  slide-in panel, per the shared `DetailPanel` shell's "direct link = full
  page" contract. This route is now just a thin host: derive the id, guard
  the "no id" router edge case, and mount `TaskDetail` in page mode with a
  back link to the catalog.
-->
<script lang="ts">
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages.js';
    import { onDestroy } from 'svelte';
    import TaskDetail from '$lib/components/admin/task-catalog/TaskDetail.svelte';
    import RunDetailPanel from '$lib/components/admin/runs/RunDetailPanel.svelte';
    import RunLogDrawer from '$lib/components/admin/runs/RunLogDrawer.svelte';
    import { runDetailPanel } from '$lib/stores/run-detail-panel.js';
    import { runLogDrawer } from '$lib/stores/run-log-drawer.js';

    // A run opened from this page's Recent Runs (or Run now's log) opens as a
    // panel over the task — this route had no host for either, so the rows
    // navigated away to the Runs page instead.
    let panelRunId = $state<string | null>(null);
    let logRunId = $state<string | null>(null);
    const unsubPanel = runDetailPanel.subscribe((v) => (panelRunId = v.runId));
    const unsubLog = runLogDrawer.subscribe((v) => (logRunId = v.runId));
    onDestroy(() => {
        unsubPanel();
        unsubLog();
        runDetailPanel.close();
        runLogDrawer.close();
    });

    let taskId = $derived.by(() => {
        // SvelteKit types params as `string | undefined`; this route requires
        // [taskId] so a missing value means the router resolved the wrong
        // route.
        const raw = $page.params.taskId ?? '';
        try {
            return decodeURIComponent(raw);
        } catch {
            return raw;
        }
    });

    let devToolsEnabled = $derived($page.data.devToolsEnabled === true);

    // Deep-link support (e.g. a health finding's "open this task" link ships
    // `?tab=failures`) — only a known tab id is honored, anything else falls
    // back to TaskDetail's own 'overview' default.
    const KNOWN_TABS = ['overview', 'runs', 'failures', 'backlog', 'settings', 'definition'];
    let initialTab = $derived.by(() => {
        const raw = $page.url.searchParams.get('tab');
        return raw && KNOWN_TABS.includes(raw)
            ? (raw as 'overview' | 'runs' | 'failures' | 'backlog' | 'settings' | 'definition')
            : undefined;
    });
</script>

{#if !taskId}
    <div class="rounded border border-red-700/30 bg-red-900/20 p-4 text-sm text-red-300">
        {m.admin_jobs_no_task_id()}
    </div>
{:else}
    <TaskDetail
        {taskId}
        mode="page"
        backHref="/admin/tasks"
        backLabel={m.route_admin_tasks_title()}
        {devToolsEnabled}
        {initialTab} />
{/if}

{#if panelRunId}
    <RunDetailPanel runId={panelRunId} onclose={() => runDetailPanel.close()} />
{/if}

{#if logRunId}
    <RunLogDrawer runId={logRunId} onclose={() => runLogDrawer.close()} />
{/if}
