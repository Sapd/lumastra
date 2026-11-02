<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { resolve } from '$lib/paths';
    import { Icon, CheckCircle, ArrowRight, ArrowPath, XMark } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { getOnboardingChecklist, triggerFileScanner } from '$lib/api/admin.js';
    import { dismissAllOnboarding } from '$lib/api/user.js';
    import { toasts } from '$lib/stores/toast.store';
    import type { OnboardingStepResponse } from '$lib/schemas/api-admin-responses.js';

    /**
     * Fresh-install "Setup checklist" card for the /admin Home first-run state
     * (spec §3.1): add a library path → run the first scan → optional: connect
     * TMDB / enable AI.
     *
     * ONE checklist component (admin-ia redesign step `wizard-onboarding`) — this
     * replaces the two that used to coexist here:
     *  - the old `SetupChecklist` derived its "done" state from props the Home
     *    page happened to have on hand (library item count, API-key presence)
     *    and could only ever be dismissed client-side (localStorage);
     *  - the old `OnboardingChecklistCard` was already backed by the
     *    server-side `onboarding_state` table (so it tracks the SCAN step too,
     *    not just "has any library item ever landed") and dismissed server-side
     *    (persists across devices/sessions) — but relied on the exact same
     *    auto-detect signals `adaptOnboarding`'s bell nudge uses.
     * Merged onto the second's server-backed shape (a strictly more complete,
     * cross-device signal set) with the first's warmer "Welcome" framing, since
     * this component now ONLY ever mounts inside Home's `isFirstRun` gate.
     *
     * Self-contained: fetches its own state via GET /api/v1/setup/onboarding
     * (auto-detects live completion from real signals — library paths, active
     * media, TMDB/AI keys) and dismisses via POST /api/onboarding/dismiss.
     * Renders nothing while loading, on fetch failure, or once every actionable
     * step is done/dismissed.
     */

    /** Bookkeeping flag, not a real setup action — never rendered as a row. */
    const NON_ACTIONABLE_STEPS = new Set(['onboarding_dismissed']);

    /** Display order (spec §3.1): library path → first scan → optional TMDB/AI/Discogs. */
    const STEP_ORDER = [
        'library_paths',
        'library_scan',
        'tmdb_config',
        'ai_config',
        'discogs_config',
    ];

    interface StepMeta {
        label: () => string;
        href: string;
        cta: () => string;
        optional?: boolean;
    }

    // step_key → display label + admin surface where it's configured. Hrefs are
    // the final IA paths (Library → Storage, Settings → Providers/AI).
    const STEP_META: Record<string, StepMeta> = {
        library_paths: {
            label: m.admin_home_setup_step_library_paths,
            href: '/admin/library/sources',
            cta: m.admin_home_setup_cta_add_library,
        },
        library_scan: {
            label: m.admin_home_setup_step_library_scan,
            href: '/admin/library/sources',
            cta: m.admin_home_setup_cta_add_library,
        },
        tmdb_config: {
            label: m.admin_home_setup_step_tmdb,
            href: '/admin/settings/providers?section=metadata&highlight=TMDB_API_KEY',
            cta: m.admin_home_setup_cta_configure,
            optional: true,
        },
        ai_config: {
            label: m.admin_home_setup_step_ai,
            href: '/admin/settings/ai',
            cta: m.admin_home_setup_cta_configure,
            optional: true,
        },
        discogs_config: {
            label: m.admin_home_setup_step_discogs,
            // Deep-links straight to the Discogs integration settings modal.
            href: '/admin/settings/plugins?settings=discogs',
            cta: m.admin_home_setup_cta_configure,
            optional: true,
        },
    };

    function stepMeta(stepKey: string): StepMeta {
        return (
            STEP_META[stepKey] ?? {
                label: () => stepKey,
                href: '/admin',
                cta: m.admin_home_setup_cta_configure,
            }
        );
    }

    let steps = $state<OnboardingStepResponse[]>([]);
    let allDismissed = $state(false);
    let loaded = $state(false);
    let dismissing = $state(false);
    let scanning = $state(false);

    const actionableSteps = $derived(
        [...steps]
            .filter((s) => !NON_ACTIONABLE_STEPS.has(s.step_key))
            .sort((a, b) => STEP_ORDER.indexOf(a.step_key) - STEP_ORDER.indexOf(b.step_key)),
    );
    const pendingCount = $derived(actionableSteps.filter((s) => !s.completed).length);
    const show = $derived(loaded && !allDismissed && pendingCount > 0);
    // "Run the first scan" only has something to scan once a library path
    // exists — before that its CTA falls back to the same "add a library" link
    // as the step above it (see stepCta below).
    const hasLibraryPath = $derived(
        steps.find((s) => s.step_key === 'library_paths')?.completed ?? false,
    );

    async function load(): Promise<void> {
        const result = await getOnboardingChecklist();
        if (!result.error && result.data) {
            steps = result.data.steps;
            allDismissed = result.data.allDismissed;
        }
        loaded = true;
    }

    async function dismissAll(): Promise<void> {
        if (dismissing) return;
        dismissing = true;
        const result = await dismissAllOnboarding();
        if (!result.error) {
            allDismissed = true;
        }
        dismissing = false;
    }

    // Bounded poll (mirrors the /setup wizard's own scan-progress poll): after
    // triggering a scan, re-check the checklist every 5s so "Run your first
    // scan" flips to done live once media lands, without polling forever if a
    // scan stalls or the operator navigates away and back.
    let scanPollTimer: ReturnType<typeof setInterval> | undefined;
    let scanPollCount = 0;
    const MAX_SCAN_POLLS = 24; // ~2 minutes at 5s

    function stopScanPolling(): void {
        if (scanPollTimer !== undefined) {
            clearInterval(scanPollTimer);
            scanPollTimer = undefined;
        }
    }

    function startScanPolling(): void {
        stopScanPolling();
        scanPollCount = 0;
        scanPollTimer = setInterval(() => {
            scanPollCount += 1;
            void load();
            const scanStep = steps.find((s) => s.step_key === 'library_scan');
            if ((scanStep?.completed ?? false) || scanPollCount >= MAX_SCAN_POLLS) {
                stopScanPolling();
            }
        }, 5000);
    }

    async function runFirstScan(): Promise<void> {
        if (scanning) return;
        scanning = true;
        const { error } = await triggerFileScanner();
        scanning = false;
        if (error) {
            toasts.error(m.admin_home_setup_scan_failed());
            return;
        }
        toasts.success(m.admin_home_setup_scan_started());
        startScanPolling();
    }

    interface StepCta {
        label: () => string;
        action: () => void;
        isLink: boolean;
        href: string;
    }

    function stepCta(step: OnboardingStepResponse): StepCta {
        const meta = stepMeta(step.step_key);
        if (step.step_key === 'library_scan' && hasLibraryPath) {
            return {
                label: scanning ? m.admin_home_setup_cta_scanning : m.admin_home_setup_cta_scan_now,
                action: () => void runFirstScan(),
                isLink: false,
                href: meta.href,
            };
        }
        return { label: meta.cta, action: () => {}, isLink: true, href: meta.href };
    }

    onMount(() => {
        void load();
    });
    onDestroy(stopScanPolling);
</script>

{#if show}
    <section class="rounded-xl border border-primary-700/40 bg-primary-950/20 p-5">
        <div class="flex items-start justify-between gap-3">
            <div>
                <h2 class="text-base font-semibold text-surface-50">
                    {m.admin_home_setup_title()}
                </h2>
                <p class="mt-0.5 text-sm text-surface-300">
                    {m.admin_home_setup_subtitle({
                        done: String(actionableSteps.length - pendingCount),
                        total: String(actionableSteps.length),
                    })}
                </p>
            </div>
            <button
                type="button"
                class="-m-1 rounded p-1 text-surface-500 hover:text-surface-300 disabled:opacity-50"
                aria-label={m.admin_home_setup_dismiss_aria()}
                disabled={dismissing}
                onclick={dismissAll}>
                <Icon src={XMark} class="h-4 w-4" />
            </button>
        </div>

        <ul class="mt-4 space-y-2">
            {#each actionableSteps as step (step.step_key)}
                {@const meta = stepMeta(step.step_key)}
                {@const cta = stepCta(step)}
                <li class="flex items-center gap-3">
                    {#if step.completed}
                        <Icon src={CheckCircle} class="h-5 w-5 shrink-0 text-emerald-400" />
                    {:else}
                        <span
                            class="h-5 w-5 shrink-0 rounded-full border-2 border-surface-600"
                            aria-hidden="true"></span>
                    {/if}
                    <span
                        class="flex-1 text-sm {step.completed
                            ? 'text-surface-400 line-through'
                            : 'text-surface-200'}">
                        {meta.label()}
                        {#if meta.optional}
                            <span class="ml-1 text-xs text-surface-500"
                                >{m.admin_home_setup_optional()}</span>
                        {/if}
                    </span>
                    {#if !step.completed}
                        {#if cta.isLink}
                            <a
                                href={resolve(cta.href)}
                                class="inline-flex items-center gap-1 rounded-md border border-primary-700/50 bg-primary-900/30 px-2.5 py-1 text-xs font-medium text-primary-200 hover:bg-primary-900/60">
                                {cta.label()}
                                <Icon src={ArrowRight} class="h-3.5 w-3.5" />
                            </a>
                        {:else}
                            <button
                                type="button"
                                class="inline-flex items-center gap-1 rounded-md border border-primary-700/50 bg-primary-900/30 px-2.5 py-1 text-xs font-medium text-primary-200 hover:bg-primary-900/60 disabled:opacity-50"
                                disabled={scanning}
                                onclick={cta.action}>
                                {#if scanning}
                                    <Icon src={ArrowPath} class="h-3.5 w-3.5 animate-spin" />
                                {/if}
                                {cta.label()}
                            </button>
                        {/if}
                    {/if}
                </li>
            {/each}
        </ul>
    </section>
{/if}
