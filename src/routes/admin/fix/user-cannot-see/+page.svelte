<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /admin/fix/user-cannot-see — why one person cannot see what another can.

  ## Every gate is shown, not just the failing one

  The support thread this replaces is "it's there, I can see it, they can't".
  A yes/no answer does not end it; a denied library group id or an age ceiling
  does. So the page renders each gate the server evaluated, in the server's
  order, with the values that produced the verdict.

  ## Gates that did not run say so

  A gate skipped because an earlier one short-circuited is rendered as "not
  evaluated", never as passed. Showing a green tick for a check nobody ran is
  the same lie as a signpost implying it measured something — and here it would
  actively mislead, because the operator would rule out the gate that is
  actually misconfigured.

  ## `mediaId` is accepted from the query string

  So the media browser can deep-link straight into a filled-in check rather than
  making the operator copy a UUID between two tabs.
-->
<script lang="ts">
    import { Icon, CheckCircle, XCircle, MinusCircle } from 'svelte-hero-icons';
    import { page } from '$app/state';
    import FixPageShell from '$lib/components/admin/fix/FixPageShell.svelte';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import { findSymptom } from '$lib/components/admin/fix/symptoms.js';
    import {
        VisibilityCheckSchema,
        type VisibilityCheck,
        type VisibilityGate,
    } from '$lib/components/admin/fix/visibility-check.schema.js';
    import { apiGet } from '$lib/api/client.js';
    import { getLocalUsers } from '$lib/api/admin.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import * as m from '$lib/paraglide/messages.js';

    const symptom = findSymptom('user-cannot-see');

    let users = $state<{ id: string; username: string }[]>([]);
    let selectedUserId = $state('');
    let mediaId = $state(page.url.searchParams.get('mediaId') ?? '');

    let result = $state<VisibilityCheck | null>(null);
    let loading = $state(false);
    let loadError = $state<ClassifiedError | null>(null);
    /** The user list failed to load: without it the form cannot be used, and says so. */
    let usersError = $state<ClassifiedError | null>(null);

    async function loadUsers(): Promise<void> {
        usersError = null;
        const res = await getLocalUsers();
        if (res.data) {
            users = res.data.items.map((u) => ({ id: u.id, username: u.username }));
            if (!selectedUserId && users.length > 0) selectedUserId = users[0].id;
        } else {
            usersError = classifyError(new Error(res.error ?? undefined), { status: res.status });
        }
    }

    $effect(() => {
        void loadUsers();
    });

    /** Only the newest check may write the result; an older one finishing late is dropped. */
    let runSeq = 0;

    async function run(): Promise<void> {
        if (!selectedUserId || !mediaId.trim()) return;
        const seq = ++runSeq;
        loading = true;
        loadError = null;
        result = null;
        const params = new URLSearchParams({ userId: selectedUserId, mediaId: mediaId.trim() });
        const res = await apiGet(
            `/api/admin/fix/visibility-check?${params.toString()}`,
            VisibilityCheckSchema,
            { strict: true },
        );
        if (seq !== runSeq) return;
        loading = false;
        if (res.data) {
            result = res.data;
        } else if (res.error) {
            loadError = classifyError(new Error(res.error), { status: res.status });
        }
    }

    /**
     * The gate's explanation in the user's language. The server sends a code
     * and its params; an unknown code (a newer server) falls back to the
     * English `detail` rather than to nothing.
     */
    function gateDetail(gate: VisibilityCheck['gates'][number]): string {
        // Each code's message takes exactly the params the server sends for that
        // code (pinned by the visibility-check tests), so the record is passed
        // through as-is.
        const p = gate.params;
        const text = ((): string => {
            switch (gate.code) {
                case 'item-missing':
                    return m.admin_fix_visibility_detail_item_missing(p as never);
                case 'item-found':
                    return m.admin_fix_visibility_detail_item_found(p as never);
                case 'files-present':
                    return m.admin_fix_visibility_detail_files_present(p as never);
                case 'files-status':
                    return m.admin_fix_visibility_detail_files_status(p as never);
                case 'files-dismissed':
                    return m.admin_fix_visibility_detail_files_dismissed(p as never);
                case 'files-container-none':
                    return m.admin_fix_visibility_detail_files_container_none(p as never);
                case 'files-discovery-only':
                    return m.admin_fix_visibility_detail_files_discovery_only(p as never);
                case 'account-deleted':
                    return m.admin_fix_visibility_detail_account_deleted(p as never);
                case 'account-disabled':
                    return m.admin_fix_visibility_detail_account_disabled(p as never);
                case 'account-active':
                    return m.admin_fix_visibility_detail_account_active(p as never);
                case 'admin-yes':
                    return m.admin_fix_visibility_detail_admin_yes(p as never);
                case 'admin-no':
                    return m.admin_fix_visibility_detail_admin_no(p as never);
                case 'library-admin':
                    return m.admin_fix_visibility_detail_library_admin(p as never);
                case 'library-open':
                    return m.admin_fix_visibility_detail_library_open(p as never);
                case 'library-partly-withheld':
                    return m.admin_fix_visibility_detail_library_partly_withheld(p as never);
                case 'library-withheld':
                    return m.admin_fix_visibility_detail_library_withheld(p as never);
                case 'age-admin':
                    return m.admin_fix_visibility_detail_age_admin(p as never);
                case 'age-none':
                    return m.admin_fix_visibility_detail_age_none(p as never);
                case 'age-unrated-visible':
                    return m.admin_fix_visibility_detail_age_unrated_visible(p as never);
                case 'age-unrated-hidden':
                    return m.admin_fix_visibility_detail_age_unrated_hidden(p as never);
                case 'age-within':
                    return m.admin_fix_visibility_detail_age_within(p as never);
                case 'age-above':
                    return m.admin_fix_visibility_detail_age_above(p as never);
                default:
                    return gate.detail;
            }
        })();
        return p.fallback ? `${text} ${m.admin_fix_visibility_detail_age_fallback()}` : text;
    }

    /**
     * `blockedBy` is a plain string, not the gate enum: the server emits
     * `'unknown'` on the one path where its per-gate detail and its
     * authoritative verdict disagree. That is the design's own safety valve, and
     * an earlier version of this function swallowed it — the `default:` arm
     * returned the AGE-RATING label, so the moment the explainer admitted it was
     * confused it rendered as a confident wrong gate name. Handle it explicitly.
     */
    function gateLabel(gate: string): string {
        switch (gate) {
            case 'item-exists':
                return m.admin_fix_visibility_gate_item_exists();
            case 'has-files':
                return m.admin_fix_visibility_gate_has_files();
            case 'account':
                return m.admin_fix_visibility_gate_account();
            case 'admin-bypass':
                return m.admin_fix_visibility_gate_admin_bypass();
            case 'library-access':
                return m.admin_fix_visibility_gate_library_access();
            case 'age-rating':
                return m.admin_fix_visibility_gate_age_rating();
            default:
                return m.admin_fix_visibility_gate_unknown();
        }
    }
</script>

{#if symptom}
    <FixPageShell title={symptom.title()} icon={symptom.icon}>
        <p class="max-w-3xl text-sm leading-relaxed text-surface-300">
            {m.admin_fix_visibility_intro()}
        </p>

        <form
            class="flex flex-wrap items-end gap-3"
            onsubmit={(e) => {
                e.preventDefault();
                void run();
            }}>
            <label class="flex flex-col gap-1">
                <span class="text-xs text-surface-400">{m.admin_fix_visibility_user_label()}</span>
                <select
                    bind:value={selectedUserId}
                    class="rounded border border-surface-700 bg-surface-900 px-2 py-1 text-sm text-surface-100">
                    {#each users as u (u.id)}
                        <option value={u.id}>{u.username}</option>
                    {/each}
                </select>
            </label>

            <label class="flex flex-col gap-1">
                <span class="text-xs text-surface-400">{m.admin_fix_visibility_media_label()}</span>
                <input
                    bind:value={mediaId}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    class="w-80 rounded border border-surface-700 bg-surface-900 px-2 py-1 font-mono text-xs text-surface-100" />
            </label>

            <button
                type="submit"
                disabled={loading || !selectedUserId || !mediaId.trim()}
                class="rounded bg-primary-700 px-3 py-1.5 text-sm text-white hover:bg-primary-600 disabled:opacity-50">
                {m.admin_fix_visibility_run()}
            </button>
        </form>
        <p class="text-xs text-surface-500">{m.admin_fix_visibility_media_hint()}</p>

        {#if usersError}
            <AsyncSection loading={false} error={usersError} onretry={() => void loadUsers()} />
        {/if}

        <AsyncSection {loading} error={loadError} onretry={() => void run()}>
            {#if result}
                <div class="space-y-5">
                    <div
                        class="rounded-lg border p-4 {!result.visible
                            ? 'border-error-700/60 bg-error-900/20'
                            : result.browsable
                              ? 'border-success-700/60 bg-success-900/20'
                              : 'border-warning-700/60 bg-warning-900/20'}">
                        <p class="text-sm font-medium text-surface-100">
                            {result.visible && !result.browsable
                                ? m.admin_fix_visibility_visible_not_browsable({
                                      username: result.username,
                                      title: result.mediaTitle,
                                  })
                                : result.visible
                                  ? m.admin_fix_visibility_visible({
                                        username: result.username,
                                        title: result.mediaTitle,
                                    })
                                  : m.admin_fix_visibility_blocked({
                                        username: result.username,
                                        title: result.mediaTitle,
                                    })}
                        </p>
                        {#if !result.visible && result.blockedBy}
                            <p class="mt-1 text-sm text-error-300">
                                {m.admin_fix_visibility_blocked_by({
                                    gate: gateLabel(result.blockedBy),
                                })}
                            </p>
                        {/if}
                        <p class="mt-1 text-xs text-surface-400">
                            {m.admin_fix_visibility_user_groups({
                                groups:
                                    result.userGroups.length > 0
                                        ? result.userGroups.join(', ')
                                        : m.admin_fix_visibility_no_groups(),
                            })}
                        </p>
                    </div>

                    <section class="space-y-2">
                        <h2 class="text-sm font-medium text-surface-200">
                            {m.admin_fix_visibility_gates_heading()}
                        </h2>
                        <ul class="divide-y divide-surface-800">
                            {#each result.gates as gate (gate.gate)}
                                <li class="flex items-start gap-3 py-2">
                                    <!--
                                      Three states, not two: a gate that did not
                                      run must never render as a pass, or the
                                      operator rules out the very thing that is
                                      misconfigured.
                                    -->
                                    <Icon
                                        src={!gate.evaluated
                                            ? MinusCircle
                                            : gate.passed
                                              ? CheckCircle
                                              : XCircle}
                                        class="mt-0.5 h-4 w-4 shrink-0 {!gate.evaluated
                                            ? 'text-surface-500'
                                            : gate.passed
                                              ? 'text-success-300'
                                              : 'text-error-300'}" />
                                    <div class="space-y-0.5">
                                        <p class="text-sm text-surface-100">
                                            {gateLabel(gate.gate)}
                                            {#if !gate.evaluated}
                                                <span class="ml-1 text-xs text-surface-500">
                                                    ({m.admin_fix_visibility_skipped()})
                                                </span>
                                            {/if}
                                        </p>
                                        <p class="text-xs leading-relaxed text-surface-400">
                                            {gateDetail(gate)}
                                        </p>
                                        {#if gate.gate === 'has-files' && !gate.passed}
                                            <p class="text-xs leading-relaxed text-surface-500">
                                                {m.admin_fix_visibility_has_files_note()}
                                            </p>
                                        {/if}
                                    </div>
                                </li>
                            {/each}
                        </ul>
                    </section>
                </div>
            {/if}
        </AsyncSection>
    </FixPageShell>
{/if}
