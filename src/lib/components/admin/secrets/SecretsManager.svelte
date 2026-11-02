<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { apiPost } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import type { PluginSecretKey } from '$lib/server/database/queries/plugin-secrets.queries.js';
    import { V1RotateSecretsResponseSchema } from '$lib/schemas/api-v1.js';

    interface Props {
        secretKeys: PluginSecretKey[];
    }

    let { secretKeys }: Props = $props();

    // Master key rotation form
    let oldMasterKey = $state('');
    let newMasterKey = $state('');
    let rotating = $state(false);
    let rotateResult = $state<{
        rotated: number;
        skipped: number;
        newVersion: number;
        notRotated: Array<{ store: string; reason: string }>;
        /** Per store, values moved off the old unbound envelope onto the row-bound one. */
        legacyUpgraded: Array<{ store: string; count: number }>;
    } | null>(null);

    async function rotateKeys(): Promise<void> {
        if (rotating) return;
        rotating = true;
        rotateResult = null;
        try {
            const { data, error } = await apiPost(
                '/api/admin/secrets/rotate',
                V1RotateSecretsResponseSchema,
                {
                    oldMasterKey,
                    newMasterKey,
                    confirmation: 'I_UNDERSTAND_THIS_RE_ENCRYPTS_ALL_SECRETS',
                },
            );
            if (error || !data) {
                toasts.error(`Rotation failed: ${error ?? 'unknown error'}`);
                oldMasterKey = '';
                newMasterKey = '';
                return;
            }
            rotateResult = {
                rotated: data.rotated,
                skipped: data.skipped,
                newVersion: data.newVersion,
                notRotated: data.notRotated ?? [],
                legacyUpgraded: Object.entries(data.legacyUpgraded ?? {})
                    .filter(([, count]) => count > 0)
                    .map(([store, count]) => ({ store, count })),
            };
            if (rotateResult.notRotated.length > 0 || rotateResult.skipped > 0) {
                toasts.error(
                    `Rotated ${rotateResult.rotated} secrets, but ${
                        rotateResult.notRotated.length + rotateResult.skipped
                    } could not be moved — do not change LUMASTRA_MASTER_KEY yet`,
                );
            } else {
                toasts.success(
                    `Rotated ${rotateResult.rotated} secrets to version ${rotateResult.newVersion}`,
                );
            }
            oldMasterKey = '';
            newMasterKey = '';
        } finally {
            rotating = false;
        }
    }

    function formatDate(d: Date | string): string {
        const date = d instanceof Date ? d : new Date(d);
        return date.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    }
</script>

<div class="space-y-8">
    <!-- Master key rotation -->
    <section class="card-bordered p-5">
        <div class="mb-4 flex items-start gap-3">
            <div class="flex-1">
                <h3 class="text-base font-semibold text-surface-100">Master Key Rotation</h3>
                <p class="mt-1 text-sm text-surface-400">
                    Re-encrypts every secret stored under the master key: plugin secrets and
                    per-user plugin credentials, the sensitive values in
                    <code class="text-xs text-cyan-300">settings.json</code>, Subsonic client
                    tokens, operator and per-user webhook signing secrets, Jellyfin (<code
                        class="text-xs text-cyan-300">/j</code
                    >) client passwords, and Live TV Xtream credentials.
                </p>
                <p class="mt-2 text-sm text-surface-400">
                    Run this <strong>first</strong>, while
                    <code class="text-xs text-cyan-300">LUMASTRA_MASTER_KEY</code> still holds the
                    <em>current</em> key. Only once it reports everything rotated, set the new key in
                    your environment and restart every replica.
                </p>
            </div>
        </div>

        <div class="space-y-3">
            <div class="space-y-1">
                <label class="block text-sm text-surface-300" for="old-key">
                    Current master key
                </label>
                <input
                    id="old-key"
                    type="password"
                    class="input w-full"
                    placeholder="Current LUMASTRA_MASTER_KEY value"
                    bind:value={oldMasterKey} />
            </div>

            <div class="space-y-1">
                <label class="block text-sm text-surface-300" for="new-key"> New master key </label>
                <input
                    id="new-key"
                    type="password"
                    class="input w-full"
                    placeholder="New LUMASTRA_MASTER_KEY value (min 32 chars)"
                    bind:value={newMasterKey} />
            </div>

            <div
                class="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
                This operation is irreversible. Ensure the new key is saved securely before
                proceeding, and keep a database + config backup: old backups can only be read with
                the old key. Two values are <em>derived</em> from the master key and cannot be
                rotated — every signed-in session is logged out (unless
                <code class="text-xs">JWT_SECRET</code> is set explicitly), and paired
                <code class="text-xs">/j</code> clients re-pair once.
            </div>

            <button
                type="button"
                class="btn btn-red"
                disabled={rotating || !oldMasterKey || !newMasterKey}
                onclick={() => void rotateKeys()}>
                {rotating ? 'Rotating…' : 'Rotate Master Key'}
            </button>

            {#if rotateResult}
                {@const incomplete = rotateResult.skipped > 0 || rotateResult.notRotated.length > 0}
                <div
                    class="rounded px-4 py-3 text-sm {incomplete
                        ? 'border border-red-800/60 bg-red-950/40 text-red-300'
                        : 'border border-green-800/60 bg-green-950/40 text-green-300'}">
                    {rotateResult.rotated} secrets rotated to encryption version {rotateResult.newVersion}
                    {#if rotateResult.skipped > 0}
                        ({rotateResult.skipped} skipped due to decryption errors)
                    {/if}
                    {#if incomplete}
                        <p class="mt-2 font-semibold">
                            Do NOT change LUMASTRA_MASTER_KEY yet — these stores are still sealed
                            with the old key:
                        </p>
                        <ul class="mt-1 list-disc space-y-0.5 pl-5">
                            {#each rotateResult.notRotated as entry (entry.store + entry.reason)}
                                <li>
                                    <span class="font-mono text-xs">{entry.store}</span> — {entry.reason}
                                </li>
                            {/each}
                        </ul>
                    {/if}
                </div>

                {#if rotateResult.legacyUpgraded.length > 0}
                    <div
                        class="rounded border border-amber-800/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
                        <p class="font-semibold">
                            This rotation also bound older secrets to the row they were stored in:
                        </p>
                        <ul class="mt-1 list-disc space-y-0.5 pl-5">
                            {#each rotateResult.legacyUpgraded as entry (entry.store)}
                                <li>
                                    <span class="font-mono text-xs">{entry.store}</span> — {entry.count}
                                    value{entry.count === 1 ? '' : 's'}
                                </li>
                            {/each}
                        </ul>
                        <p class="mt-2">
                            Each of those is now valid only in the row it was in at that moment. If
                            one of them had been moved there — by a restore, a manual edit or an
                            attacker with database write access — that is now permanent. Check
                            System Health → Security Self-Check before the next rotation.
                        </p>
                    </div>
                {/if}
            {/if}
        </div>
    </section>

    <!-- Plugin secrets index -->
    <section>
        <div class="mb-3 flex items-center gap-3">
            <h3 class="text-base font-semibold text-surface-100">Plugin Secrets</h3>
            <span class="rounded bg-surface-700 px-2 py-0.5 text-xs text-surface-400">
                {secretKeys.length} entries
            </span>
        </div>

        <div
            class="mb-4 rounded border border-amber-800/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
            This view shows secret keys (not values) for audit purposes. To add, update, or delete
            secrets use the environment-variable seeding path or refer to §13.5 of the operator
            guide.
        </div>

        {#if secretKeys.length === 0}
            <p class="py-6 text-center text-sm text-surface-400">No plugin secrets found.</p>
        {:else}
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="border-b border-surface-700 text-left text-surface-400">
                            <th class="px-4 py-3 font-medium">Plugin</th>
                            <th class="px-4 py-3 font-medium">Key</th>
                            <th class="px-4 py-3 font-medium">Encryption Version</th>
                            <th class="px-4 py-3 font-medium">Created</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-surface-700/50">
                        {#each secretKeys as sk (`${sk.pluginId}:${sk.key}`)}
                            <tr class="hover:bg-surface-800/30 transition-colors">
                                <td class="px-4 py-3 font-mono text-xs text-surface-300">
                                    {sk.pluginId}
                                </td>
                                <td class="px-4 py-3 font-mono text-xs text-surface-300">
                                    {sk.key}
                                </td>
                                <td class="px-4 py-3 tabular-nums text-surface-400">
                                    v{sk.encryptionVersion}
                                </td>
                                <td class="px-4 py-3 text-surface-400">
                                    {formatDate(sk.createdAt)}
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    </section>
</div>
