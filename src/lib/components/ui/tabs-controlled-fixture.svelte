<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only

Test fixture for Tabs.svelte.test.ts — a CONTROLLED parent in the shape of
TaskDetail + DetailPanel: it owns the active-tab state (drives the content
off it), passes `active` down WITHOUT bind:, follows only via `onchange`,
and has a mount-time effect that resets the state to a default (TaskDetail
does exactly this for panel reuse across task ids). A localStorage tab
restore must converge highlight AND parent state to the restored tab even
against that reset.
-->
<script lang="ts">
    import Tabs from './Tabs.svelte';

    interface Props {
        items: { id: string; label: string }[];
        defaultTab: string;
    }

    let { items, defaultTab }: Props = $props();

    // Intentionally init-only, like TaskDetail's own `activeTab` state.
    // svelte-ignore state_referenced_locally
    let activeTab = $state(defaultTab);

    /** How often the reset effect ran — the side effect that makes this a
     *  real effect (TaskDetail's effect also re-fetches the task). */
    let resets = 0;

    // Mimics TaskDetail's reset-on-(re)mount effect (which resets the tab
    // AND reloads the task whenever the panel is reused for a new task id).
    $effect(() => {
        activeTab = defaultTab;
        resets += 1;
    });
</script>

<Tabs {items} active={activeTab} onchange={(d) => (activeTab = d.id)} syncToUrl />
<div data-testid="parent-content">{activeTab}</div>
