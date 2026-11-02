<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  The plugin catalog: repositories an operator subscribes to, and what those
  repositories advertise.

  The thing this UI must never imply is that a catalog is a trusted source. It
  is not. Installing from here calls the SAME verified install path as pasting a
  manifest URL and signature by hand, with the same operator-configured keys and
  the same ABI, publisher-continuity and anti-rollback gates — so the catalog is
  an AUTOFILL for that form, and a repository that lies produces a clean install
  failure rather than a bad install. The copy says so out loud, because an
  operator who believes "it was in the catalog" means "someone vetted it" is
  exactly the operator this model does not protect.

  Everything shown per plugin (title, description, publisher, version) is
  advisory and re-derived from the signed manifest before anything runs.
-->
<script lang="ts">
    import {
        Icon,
        Trash,
        ArrowPath,
        Plus,
        ShieldExclamation,
        ArrowUpTray,
    } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { toasts } from '$lib/stores/toast.store';
    import {
        addPluginRepository,
        removePluginRepository,
        syncPluginRepositories,
        installExternalPlugin,
    } from '$lib/api/admin.js';
    import { catalogAction } from '$lib/utils/admin/plugin-catalog-actions.js';

    interface Repository {
        id: string;
        url: string;
        name: string | null;
        enabled: boolean;
        lastSyncedAt: string | null;
        lastError: string | null;
        indexUpdatedAt: string | null;
    }

    interface CatalogEntry {
        repositoryId: string;
        name: string;
        title: string | null;
        description: string | null;
        publisher: string | null;
        homepage: string | null;
        repositoryName: string | null;
        version: string | null;
        manifestUrl: string | null;
        signature: string | null;
        security: boolean;
        advisoryKeyId: string | null;
        installedVersion: string | null;
    }

    let {
        repositories,
        catalog,
        installEnabled,
        trustedKeysConfigured,
        onchanged,
    }: {
        repositories: Repository[];
        catalog: CatalogEntry[];
        installEnabled: boolean;
        trustedKeysConfigured: boolean;
        onchanged: () => void;
    } = $props();

    let newUrl = $state('');
    let adding = $state(false);
    let syncing = $state(false);
    // Scoped per ROW, not per plugin name — the same plugin can appear from
    // two repositories, and installing one must not blank the other's button.
    let busyRow = $state<string | null>(null);

    const canInstall = $derived(installEnabled && trustedKeysConfigured);

    /** "3 days ago" — an operator needs the AGE of an index, not its timestamp. */
    function age(iso: string | null): string {
        if (!iso) return m.admin_plugins_page_catalog_age_never();
        const then = Date.parse(iso);
        if (Number.isNaN(then)) return m.admin_plugins_page_catalog_age_unknown();
        const mins = Math.floor((Date.now() - then) / 60000);
        if (mins < 1) return m.admin_plugins_page_catalog_age_just_now();
        if (mins < 60) return m.admin_plugins_page_catalog_age_minutes({ mins });
        const hours = Math.floor(mins / 60);
        if (hours < 24) return m.admin_plugins_page_catalog_age_hours({ hours });
        return m.admin_plugins_page_catalog_age_days({ days: Math.floor(hours / 24) });
    }

    async function add(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        const url = newUrl.trim();
        if (!url || adding) return;
        adding = true;
        const { data, error } = await addPluginRepository(url);
        adding = false;
        if (error) {
            toasts.error(error);
            return;
        }
        // The add syncs immediately, so a URL that does not serve a usable index
        // says so NOW rather than presenting an empty catalog to puzzle over.
        if (data?.sync?.error) {
            toasts.error(
                m.admin_plugins_page_catalog_toast_add_index_error({ error: data.sync.error }),
            );
        } else {
            toasts.success(
                m.admin_plugins_page_catalog_toast_add_success({
                    count: data?.sync?.entries ?? 0,
                }),
            );
        }
        newUrl = '';
        onchanged();
    }

    async function remove(repo: Repository): Promise<void> {
        const { error } = await removePluginRepository(repo.id);
        if (error) {
            toasts.error(error);
            return;
        }
        // Installed plugins are unaffected — they keep running; only the
        // advertising stops. Say so, or removing a repository looks destructive.
        toasts.success(m.admin_plugins_page_catalog_toast_remove_success());
        onchanged();
    }

    async function syncAll(): Promise<void> {
        if (syncing) return;
        syncing = true;
        const { data, error } = await syncPluginRepositories();
        syncing = false;
        if (error) {
            toasts.error(error);
            return;
        }
        const failed = (data?.outcomes ?? []).filter((o) => o.error).length;
        if (failed > 0) {
            toasts.error(m.admin_plugins_page_catalog_toast_sync_failed({ count: failed }));
        } else {
            toasts.success(m.admin_plugins_page_catalog_toast_sync_success());
        }
        onchanged();
    }

    async function install(entry: CatalogEntry): Promise<void> {
        if (!entry.manifestUrl || !entry.signature || busyRow) return;
        busyRow = `${entry.repositoryId}:${entry.name}`;
        const { error } = await installExternalPlugin({
            manifestUrl: entry.manifestUrl,
            signature: entry.signature,
        });
        busyRow = null;
        if (error) {
            // Includes every verification failure. A repository that advertised
            // something it cannot back with a trusted signature lands here.
            toasts.error(error);
            return;
        }
        toasts.success(m.admin_plugins_page_catalog_toast_install_success({ name: entry.name }));
        onchanged();
    }
</script>

<div class="space-y-6">
    <!-- ── Repositories ─────────────────────────────────────────────────── -->
    <div class="card-base space-y-4">
        <div class="between">
            <div>
                <h3 class="text-lg font-medium text-white">
                    {m.admin_plugins_page_catalog_repositories_title()}
                </h3>
                <p class="text-hint mt-1">
                    {m.admin_plugins_page_catalog_repositories_desc()}
                </p>
            </div>
            {#if repositories.length > 0}
                <button
                    type="button"
                    class="btn-secondary text-sm inline-flex items-center gap-2"
                    onclick={syncAll}
                    disabled={syncing}>
                    <Icon src={ArrowPath} class="w-4 h-4 {syncing ? 'animate-spin' : ''}" />
                    {syncing
                        ? m.admin_plugins_page_catalog_syncing()
                        : m.admin_plugins_page_catalog_sync_now()}
                </button>
            {/if}
        </div>

        {#if repositories.length > 0}
            <ul class="divide-y divide-surface-700">
                {#each repositories as repo (repo.id)}
                    <li class="py-3 flex items-start justify-between gap-4">
                        <div class="min-w-0">
                            <p class="text-white font-medium truncate">{repo.name || repo.url}</p>
                            <p class="text-caption truncate">{repo.url}</p>
                            <p class="text-hint mt-1">
                                {m.admin_plugins_page_catalog_synced({
                                    age: age(repo.lastSyncedAt),
                                })}
                                {#if repo.indexUpdatedAt}
                                    · {m.admin_plugins_page_catalog_index_published({
                                        age: age(repo.indexUpdatedAt),
                                    })}
                                {/if}
                            </p>
                            {#if repo.lastError}
                                <p class="text-sm text-red-400 mt-1">{repo.lastError}</p>
                            {/if}
                        </div>
                        <button
                            type="button"
                            class="btn-secondary text-sm inline-flex items-center gap-1 shrink-0"
                            onclick={() => remove(repo)}
                            title={m.admin_plugins_page_catalog_remove_title()}>
                            <Icon src={Trash} class="w-4 h-4" />
                            {m.admin_plugins_page_catalog_remove()}
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}

        <!-- items-stretch, not items-start: the button has no intrinsic height
             to match the input's, so top-aligning it left a short control
             floating beside a taller field. shrink-0 keeps the label from
             wrapping when the URL is long. -->
        <form class="flex gap-2 items-stretch" onsubmit={add}>
            <label class="sr-only" for="repo-url"
                >{m.admin_plugins_page_catalog_repo_url_label()}</label>
            <input
                id="repo-url"
                class="input flex-1"
                type="url"
                placeholder="https://example.org/plugins/index.json"
                bind:value={newUrl}
                disabled={adding} />
            <button
                type="submit"
                class="btn-primary text-sm inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-3"
                disabled={adding || newUrl.trim().length === 0}>
                <Icon src={Plus} class="w-4 h-4" />
                {adding
                    ? m.admin_plugins_page_catalog_adding()
                    : m.admin_plugins_page_catalog_add()}
            </button>
        </form>
    </div>

    <!-- ── Available plugins ────────────────────────────────────────────── -->
    {#if catalog.length > 0}
        <div class="space-y-3">
            <h3 class="text-lg font-medium text-white">
                {m.admin_plugins_page_catalog_available_title()}
            </h3>
            {#if !canInstall}
                <p class="text-hint">
                    {m.admin_plugins_page_catalog_browsing_only_prefix()}
                    <code class="bg-surface-800 px-1 rounded"
                        >PLUGINS_EXTERNAL_INSTALL_ENABLED</code>
                    {m.admin_plugins_page_catalog_browsing_only_suffix()}
                </p>
            {/if}
            <div class="grid gap-3">
                <!-- Keyed on the repository UUID, not its display name: `name` comes from
                     the synced index, is nullable, and is not unique — two mirrors of
                     the same repository advertising the same plugin would collide, and
                     a duplicate {#each} key takes down the whole admin page. -->
                {#each catalog as entry (`${entry.repositoryId}:${entry.name}`)}
                    {@const action = catalogAction(entry)}
                    <div class="card-base flex items-start justify-between gap-4">
                        <div class="min-w-0">
                            <div class="flex items-center gap-2 flex-wrap">
                                <span class="text-white font-medium"
                                    >{entry.title || entry.name}</span>
                                {#if entry.version}
                                    <span class="text-caption">v{entry.version}</span>
                                {/if}
                                {#if entry.security}
                                    <span
                                        class="inline-flex items-center gap-1 text-xs text-amber-300">
                                        <Icon src={ShieldExclamation} class="w-4 h-4" />
                                        {m.admin_plugins_page_catalog_security_release()}
                                    </span>
                                {/if}
                            </div>
                            {#if entry.description}
                                <p class="text-hint mt-1">{entry.description}</p>
                            {/if}
                            <p class="text-caption mt-1">
                                {#if entry.publisher}{entry.publisher} ·{/if}
                                {m.admin_plugins_page_catalog_from({
                                    repo:
                                        entry.repositoryName ||
                                        m.admin_plugins_page_catalog_unnamed_repo(),
                                })}
                                {#if entry.installedVersion}
                                    · {m.admin_plugins_page_catalog_installed_version({
                                        version: entry.installedVersion,
                                    })}
                                {/if}
                            </p>
                        </div>

                        <div class="shrink-0">
                            {#if action === 'unavailable'}
                                <!-- Advertised, but no version matches this host's
                                     plugin ABI. Saying so beats offering an
                                     install that would be refused. -->
                                <span class="text-caption"
                                    >{m.admin_plugins_page_catalog_not_compatible()}</span>
                            {:else if action === 'current'}
                                <span class="text-caption"
                                    >{m.admin_plugins_page_catalog_up_to_date()}</span>
                            {:else}
                                <button
                                    type="button"
                                    class="btn-primary text-sm inline-flex items-center gap-1"
                                    onclick={() => install(entry)}
                                    disabled={!canInstall || busyRow !== null}>
                                    <Icon src={ArrowUpTray} class="w-4 h-4" />
                                    {#if busyRow === `${entry.repositoryId}:${entry.name}`}
                                        {m.admin_plugins_page_catalog_verifying()}
                                    {:else if action === 'update'}
                                        {m.admin_plugins_page_catalog_update_to({
                                            version: entry.version ?? '',
                                        })}
                                    {:else}
                                        {m.admin_plugins_page_catalog_install()}
                                    {/if}
                                </button>
                            {/if}
                        </div>
                    </div>
                {/each}
            </div>
        </div>
    {/if}
</div>
