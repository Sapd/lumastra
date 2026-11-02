<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Operator-facing help for the task system (Task Catalog / Runs / Pipeline /
  circuit breaker). Reached via the "Learn more" links in those pages' help
  popovers, the pipeline intro card, and the circuit breaker disclosure — not
  part of the admin nav (the admin layout renders any /admin/* route, so no
  nav entry is required). Sections carry stable ids so callers can deep-link
  to the relevant part with a `#anchor`.
-->
<script lang="ts">
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
</script>

<svelte:head>
    <title>{m.admin_help_tasks_page_title()}</title>
</svelte:head>

<div class="mx-auto max-w-3xl space-y-8 p-4">
    <a
        href={resolve('/admin/tasks')}
        class="inline-block text-xs font-medium text-sky-400 hover:text-sky-300 hover:underline">
        {m.admin_help_tasks_back_link()}
    </a>

    <header>
        <h1 class="text-2xl font-semibold text-white">{m.admin_help_tasks_heading()}</h1>
        <p class="mt-1 text-sm text-zinc-400">{m.admin_help_tasks_intro()}</p>
    </header>

    <section id="catalog" class="space-y-2">
        <h2 class="text-lg font-semibold text-white">{m.admin_help_catalog_heading()}</h2>
        <p class="text-sm text-zinc-300">{m.admin_help_catalog_p1()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_catalog_p2()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_catalog_p3()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_catalog_p4()}</p>
    </section>

    <section id="runs" class="space-y-2">
        <h2 class="text-lg font-semibold text-white">{m.admin_help_runs_heading()}</h2>
        <p class="text-sm text-zinc-300">{m.admin_help_runs_p1()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_runs_p2()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_runs_p3()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_runs_p4()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_runs_p5()}</p>
    </section>

    <section id="pipeline" class="space-y-2">
        <h2 class="text-lg font-semibold text-white">{m.admin_help_pipeline_heading()}</h2>
        <p class="text-sm text-zinc-300">{m.admin_help_pipeline_p1()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_pipeline_p2()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_pipeline_p3()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_pipeline_p4()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_pipeline_p5()}</p>
    </section>

    <section id="circuit-breaker" class="space-y-2">
        <h2 class="text-lg font-semibold text-white">{m.admin_help_circuit_breaker_heading()}</h2>
        <p class="text-sm text-zinc-300">{m.admin_help_circuit_breaker_p1()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_circuit_breaker_p2()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_circuit_breaker_p3()}</p>
    </section>

    <section id="backlog-vs-runs" class="space-y-2">
        <h2 class="text-lg font-semibold text-white">{m.admin_help_backlog_vs_runs_heading()}</h2>
        <p class="text-sm text-zinc-300">{m.admin_help_backlog_vs_runs_p1()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_backlog_vs_runs_p2()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_backlog_vs_runs_p3()}</p>
        <p class="text-sm text-zinc-300">{m.admin_help_backlog_vs_runs_p4()}</p>
    </section>

    <section id="when-something-is-red" class="space-y-2">
        <h2 class="text-lg font-semibold text-white">{m.admin_help_when_red_heading()}</h2>
        <p class="text-sm text-zinc-300">{m.admin_help_when_red_intro()}</p>
        <ol class="list-decimal space-y-1 pl-5 text-sm text-zinc-300">
            <li>{m.admin_help_when_red_step1()}</li>
            <li>{m.admin_help_when_red_step2()}</li>
            <li>{m.admin_help_when_red_step3()}</li>
            <li>{m.admin_help_when_red_step4()}</li>
            <li>{m.admin_help_when_red_step5()}</li>
        </ol>
    </section>
</div>
