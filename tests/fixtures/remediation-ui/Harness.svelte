<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import IdentifyModal from '../../../src/lib/components/admin/IdentifyModal.svelte';
    import TaskFailuresList from '../../../src/lib/components/admin/task-catalog/TaskFailuresList.svelte';
    import AttentionItemRow from '../../../src/lib/components/admin/attention/AttentionItemRow.svelte';
    import ModalContainer from '../../../src/lib/components/ui/ModalContainer.svelte';
    import ToastContainer from '../../../src/lib/components/ui/ToastContainer.svelte';
    import { attentionItem } from '../../../src/lib/shared/__fixtures__/attention-section-ids.js';
    let { sourceId }: { sourceId: string } = $props();
    const view = new URL(location.href).searchParams.get('view');
    let open = $state(true);
    let outcome = $state('');
    const operational = attentionItem({
        id: 'dead-letter:plugin-codec',
        severity: 'critical',
        type: 'dead-letter',
        domain: 'tasks',
        title: '3 items stopped at media analysis',
        detail: 'Unsupported codec VVC; encrypted bytes; truncated unreadable media. Check the file and task failures.',
        actions: [
            { kind: 'investigate', label: 'View pipeline', href: '/admin/tasks/pipeline' },
            { kind: 'bulk-retry', label: 'Retry all', stageId: 'plugin-codec' },
        ],
    });
    const identity = attentionItem({
        id: 'gave-up:all',
        severity: 'warning',
        type: 'needs-reidentification',
        domain: 'library',
        title: '1 item needs a corrected provider match',
        detail: 'TMDB id no longer exists (404)',
        actions: [
            { kind: 'investigate', label: 'Fix matches', href: '/admin/library/fix-matches' },
        ],
    });
</script>

{#if view === 'retry'}
    <main class="max-w-4xl mx-auto p-8 space-y-6 text-white">
        <h1 class="text-xl font-bold">Controlled intro retry fixture</h1>
        <p>
            Two automatic poison exclusions, one failed item and one intentional operator skip.
            Retry should restore 3; history remains visible.
        </p>
        <TaskFailuresList
            taskId="lumastra-intro-analyzer"
            coveredStageIds={['fixture-intro-visual']} />
    </main>
{:else if view === 'attention'}
    <main class="max-w-4xl mx-auto p-8 space-y-6 text-white">
        <h1 class="text-xl font-bold">Controlled failure routing fixture</h1>
        <AttentionItemRow item={operational} onAck={() => {}} />
        <AttentionItemRow item={identity} onAck={() => {}} />
    </main>
{:else if open}
    <IdentifyModal
        item={{
            id: sourceId,
            title: 'Magic Repo Man',
            mediaType: view === 'movie' || view === 'movie-failure' ? 'movie' : 'series',
        }}
        onidentified={(id) => {
            open = false;
            outcome = `Repair and merge completed. Retained entry: ${id}`;
        }}
        onclose={() => {
            open = false;
            outcome = 'Cancelled. Reload to begin again.';
        }} />
{:else}<p class="p-8 text-white">{outcome}</p>{/if}
<ModalContainer />
<ToastContainer />
