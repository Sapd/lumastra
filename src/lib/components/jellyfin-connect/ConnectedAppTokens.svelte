<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { onMount } from 'svelte';
    import { Icon, Key, Trash, Plus } from 'svelte-hero-icons';
    import TokenSuccessModal from '$lib/components/admin/TokenSuccessModal.svelte';
    import { toasts } from '$lib/stores/toast.store';
    import { apiGet, apiPost, apiDelete } from '$lib/api/client.js';
    import { z } from 'zod';
    import { PatInfoSchema, PatCreateResponseSchema } from '$lib/schemas/api-admin-responses.js';

    import {
        UserTokenInfoSchema,
        UserTokenCreateResponseSchema,
    } from '$lib/schemas/api-user-responses';
    import { getLocalUsers } from '$lib/api/admin';
    import type { PublicAuthor } from '$lib/schemas/public-author';

    type Token = {
        id: number;
        name: string;
        tokenPrefix: string;
        createdAt: string;
        lastUsedAt: string | null;
        lastUsedIp: string | null;
        usageCount: number;
        expiresAt: string | null;
        isExpired?: boolean;
        owner?: PublicAuthor;
    };

    interface Props {
        mode?: 'user' | 'admin';
        targetUserId?: string;
    }

    let { mode = 'user', targetUserId }: Props = $props();

    let tokens = $state<Token[]>([]);
    let loading = $state(true);
    let creating = $state(false);
    let newName = $state('');
    // Admin mode without a fixed targetUserId needs a per-creation username.
    let users = $state<Array<{ id: string; displayName?: string | null }>>([]);
    let newUserId = $state('');
    let createdToken = $state<{ token: string; name: string } | null>(null);
    let errorMsg = $state<string | null>(null);
    // Set when the API returns 404 from the feature-flag gate (FEATURE_USER_PATS off) —
    // see the 'feature' case in src/lib/server/api/mount.ts, which uses ApiProblem.notFound().
    // Suppresses the input row and replaces the description with a hint.
    let featureDisabled = $state(false);

    const adminNeedsUserInput = $derived(mode === 'admin' && !targetUserId);
    const effectiveUserId = $derived(targetUserId ?? newUserId.trim());

    // Shared page block used by both list schemas
    const PageBlock = z.object({
        limit: z.number(),
        offset: z.number().optional(),
        hasMore: z.boolean(),
        total: z.number().optional(),
    });

    // Admin PAT list schema: server returns { items, page } via paginate()
    const AdminPatListSchema = z.object({
        items: z.array(PatInfoSchema),
        page: PageBlock,
    });

    // User-PAT list schema: /api/me/pats returns { items, page } via paginate()
    const UserPatListSchema = z.object({ items: z.array(UserTokenInfoSchema), page: PageBlock });
    const UserPatCreateSchema = UserTokenCreateResponseSchema;

    async function load(): Promise<void> {
        loading = true;
        errorMsg = null;
        featureDisabled = false;
        try {
            if (mode === 'admin') {
                // Admin path: GET /api/admin/pats?scope=jellyfin_compat[&userId=...]
                let url = '/api/admin/pats?scope=jellyfin_compat';
                if (targetUserId) url += `&userId=${encodeURIComponent(targetUserId)}`;
                const { data, error, status } = await apiGet(url, AdminPatListSchema);
                if (status === 404) {
                    featureDisabled = true;
                    tokens = [];
                    return;
                }
                if (error) throw new Error(error);
                tokens = (data?.items ?? []) as Token[];
            } else {
                // User path: GET /api/me/pats?scope=jellyfin_compat
                const { data, error, status } = await apiGet(
                    '/api/me/pats?scope=jellyfin_compat',
                    UserPatListSchema,
                );
                if (status === 404) {
                    featureDisabled = true;
                    tokens = [];
                    return;
                }
                if (error) throw new Error(error);
                tokens = (data?.items ?? []) as Token[];
            }
        } catch (err) {
            errorMsg = err instanceof Error ? err.message : 'Failed to load tokens';
        } finally {
            loading = false;
        }
    }

    async function create(): Promise<void> {
        if (!newName.trim()) return;
        if (mode === 'admin' && !effectiveUserId) {
            errorMsg = 'Select a user to create a token in admin mode.';
            return;
        }
        creating = true;
        errorMsg = null;
        try {
            const body: Record<string, unknown> = {
                name: newName.trim(),
                scopes: ['jellyfin_compat'],
            };
            if (mode === 'admin') body.userId = effectiveUserId;

            const url = mode === 'admin' ? '/api/admin/pats' : '/api/me/pats';
            const schema = mode === 'admin' ? PatCreateResponseSchema : UserPatCreateSchema;
            const { data, error } = await apiPost(url, schema, body);
            if (error) throw new Error(error);
            if (!data?.token) throw new Error('No token in response');
            createdToken = { token: data.token, name: newName.trim() };
            newName = '';
            if (adminNeedsUserInput) newUserId = '';
            await load();
        } catch (err) {
            errorMsg = err instanceof Error ? err.message : 'Failed to create token';
        } finally {
            creating = false;
        }
    }

    async function revoke(id: number, name: string): Promise<void> {
        if (!confirm(`Revoke "${name}"? This cannot be undone.`)) return;
        errorMsg = null;
        try {
            const url = mode === 'admin' ? `/api/admin/pats/${id}` : `/api/me/pats/${id}`;
            const schema = z.null();
            const { error } = await apiDelete(url, schema);
            if (error) throw new Error(error);
            toasts.success(m.toast_token_revoked());
            await load();
        } catch (err) {
            errorMsg = err instanceof Error ? err.message : 'Failed to revoke token';
        }
    }

    function formatDate(s: string | null): string {
        if (!s) return 'Never';
        return new Date(s).toLocaleString();
    }

    onMount(() => {
        void load();
        if (mode === 'admin')
            void getLocalUsers().then(({ data }) => {
                if (data) users = data.items;
            });
    });
</script>

<section class="space-y-3">
    <div>
        <p class="text-xs text-surface-400 mb-1 uppercase tracking-wide flex items-center gap-1.5">
            <Icon src={Key} class="w-3.5 h-3.5" />
            {m.jellyfin_connect_api_token_label()}
        </p>
        {#if featureDisabled}
            <p class="text-xs text-surface-500">{m.jellyfin_connect_api_token_disabled()}</p>
        {:else}
            <p class="text-xs text-surface-500">
                {m.jellyfin_connect_api_token_description()}
            </p>
        {/if}
    </div>

    {#if errorMsg}
        <div class="rounded bg-red-900/20 border border-red-700/40 p-3 text-sm text-red-200">
            {errorMsg}
        </div>
    {/if}

    {#if loading}
        <div class="flex justify-center py-4">
            <span class="loading-spinner loading-spinner-white loading-spinner-sm"></span>
        </div>
    {:else if featureDisabled}
        <!-- nothing else: hint above is enough -->
    {:else if tokens.length === 0}
        <p class="text-sm text-surface-400 py-1">{m.jellyfin_connect_no_tokens_yet()}</p>
    {:else}
        <div class="bg-surface-900 rounded-lg overflow-hidden">
            <table class="w-full text-sm">
                <thead>
                    <tr class="text-left text-surface-400 border-b border-surface-700/50">
                        <th class="px-3 py-2 font-medium">Name</th>
                        {#if mode === 'admin'}<th class="px-3 py-2 font-medium">User</th>{/if}
                        <th class="px-3 py-2 font-medium">Prefix</th>
                        <th class="px-3 py-2 font-medium">Last used</th>
                        <th class="px-3 py-2 font-medium">Last IP</th>
                        <th class="px-3 py-2"></th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-surface-700/30">
                    {#each tokens as t (t.id)}
                        <tr class:opacity-50={t.isExpired}>
                            <td class="px-3 py-2">{t.name}</td>
                            {#if mode === 'admin'}<td class="px-3 py-2 text-surface-400"
                                    >{t.owner?.displayName ?? '—'}</td
                                >{/if}
                            <td class="px-3 py-2"
                                ><code class="text-xs font-mono text-primary-300"
                                    >{t.tokenPrefix}…</code
                                ></td>
                            <td class="px-3 py-2 text-surface-400 text-xs"
                                >{formatDate(t.lastUsedAt)}</td>
                            <td class="px-3 py-2 text-surface-400 text-xs"
                                >{t.lastUsedIp ?? '—'}</td>
                            <td class="px-3 py-2 text-right">
                                <button
                                    onclick={() => revoke(t.id, t.name)}
                                    class="text-red-400 hover:text-red-300 transition-colors"
                                    title={m.jellyfin_connect_revoke_token_title()}>
                                    <Icon src={Trash} class="w-4 h-4" />
                                </button>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}

    {#if !featureDisabled}
        <div class="flex gap-2 items-center flex-wrap">
            {#if adminNeedsUserInput}
                <select
                    bind:value={newUserId}
                    class="input variant-form-material text-sm"
                    style="max-width: 12rem;">
                    <option value="">—</option>
                    {#each users as user (user.id)}
                        <option value={user.id}>{user.displayName ?? user.id}</option>
                    {/each}
                </select>
            {/if}
            <input
                bind:value={newName}
                placeholder="Token name (e.g. Mac jellyfin-rpc)"
                class="input variant-form-material flex-1 text-sm"
                onkeydown={(e) => {
                    if (e.key === 'Enter') void create();
                }} />
            <button
                onclick={() => void create()}
                disabled={creating || !newName.trim() || (adminNeedsUserInput && !newUserId.trim())}
                class="btn btn-sm variant-soft-primary shrink-0">
                {#if creating}
                    <span class="loading-spinner loading-spinner-white loading-spinner-sm"></span>
                {:else}
                    <Icon src={Plus} class="w-4 h-4" />
                {/if}
                <span>{creating ? 'Creating…' : 'New Token'}</span>
            </button>
        </div>
    {/if}
</section>

{#if createdToken}
    <TokenSuccessModal token={createdToken.token} onClose={() => (createdToken = null)} />
{/if}
