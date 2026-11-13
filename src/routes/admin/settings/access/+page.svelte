<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Settings → Access. The in-app group manager owns the top of the page; the
  three config sections that decide who may reach this server — `groups`
  (external IdP group mapping), `auth` (login / OIDC) and `social` (what users
  may see about each other) — moved here off the general settings page and
  render below it through the shared settings framework, so there is exactly
  ONE save path on this page.
-->
<script lang="ts">
    import { untrack, onDestroy } from 'svelte';
    import { Icon, ArrowPath, Trash, Plus, XMark, MagnifyingGlass } from 'svelte-hero-icons';
    import { AdminSettingsPage, SettingSection } from '$lib/components/admin';
    import AuthDiagnosticsPanel from '$lib/components/admin/settings/AuthDiagnosticsPanel.svelte';
    import ActivitySharingDefaultPanel from '$lib/components/admin/settings/ActivitySharingDefaultPanel.svelte';
    import SocialAudiencePanel from '$lib/components/admin/settings/SocialAudiencePanel.svelte';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { toasts } from '$lib/stores/toast.store';
    import type {
        AccessGroup,
        AccessGroupMember,
        AccessCapability,
    } from '$lib/schemas/api-admin-access';
    import type { PageData, ActionData } from './$types';
    import { z } from 'zod';
    import { NoContentSchema } from '$lib/schemas/common.js';
    import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '$lib/api/client.js';
    import { getGroupReferencingSettings, isSettingVisible } from '$lib/config/schema';
    import type { SectionDefinition, SettingDefinition } from '$lib/config/schema';
    import { getPageForSection } from '$lib/config/admin-settings-pages';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        data: PageData;
        form: ActionData;
    }

    let { data, form }: Props = $props();

    // Boolean capability vocabulary (max_age_rating + livetv priority handled separately).
    // `flag` ties an entertainment-specific capability to its feature: it is only offered
    // when that feature is configured, so training-only instances don't surface
    // request/acquisition/live-tv capabilities at all.
    type CapFlag = 'requests' | 'liveTv' | 'mediaManagement';
    const BOOLEAN_CAPS: { key: AccessCapability; label: string; flag?: CapFlag }[] = [
        { key: 'admin', label: 'Admin (confers everything)' },
        { key: 'watch', label: 'Watch (see all streams)' },
        { key: 'livetv', label: 'Live TV', flag: 'liveTv' },
        { key: 'requests', label: 'Media Requests', flag: 'requests' },
        { key: 'moderator', label: 'Moderator' },
        { key: 'arr_manager', label: 'Media Management', flag: 'mediaManagement' },
    ];
    const capabilityFlags = $derived(
        (data.capabilityFlags ?? {
            requests: false,
            liveTv: false,
            mediaManagement: false,
        }) as Record<CapFlag, boolean>,
    );
    const visibleCaps = $derived(BOOLEAN_CAPS.filter((c) => !c.flag || capabilityFlags[c.flag]));

    let groups = $state<AccessGroup[]>(untrack(() => data.initialGroups) ?? []);
    let loading = $state(false);
    let savingCapabilities = $state(false);
    let removingMember = $state(false);

    // Create form
    let newName = $state('');
    let creating = $state(false);

    // Selected group for the Members panel
    let selectedGroupId = $state<string | null>(null);
    let members = $state<AccessGroupMember[]>([]);
    let membersLoading = $state(false);

    // User search / autocomplete state
    interface UserSearchResult {
        username: string;
        id: string;
    }
    let userSearchQuery = $state('');
    let userSearchResults = $state<UserSearchResult[]>([]);
    let userSearchLoading = $state(false);
    // A failed search must not read as "No users found".
    let userSearchError = $state<string | null>(null);
    let userSearchTimer: ReturnType<typeof setTimeout> | null = null;
    let memberRequest = 0;
    let searchRequest = 0;
    onDestroy(() => {
        if (userSearchTimer) clearTimeout(userSearchTimer);
        memberRequest++;
        searchRequest++;
    });
    let addingMember = $state(false);
    let userSearchActiveIndex = $state(-1);
    const USER_SEARCH_LISTBOX_ID = 'user-search-listbox';

    let selectedGroup = $derived(groups.find((g) => g.id === selectedGroupId) ?? null);

    function hasCap(group: AccessGroup, cap: AccessCapability): boolean {
        return group.capabilities.some((c) => c.capability === cap);
    }

    function ageCap(group: AccessGroup): string {
        const c = group.capabilities.find((x) => x.capability === 'max_age_rating');
        return c?.value ?? '';
    }

    function priorityHigh(group: AccessGroup): boolean {
        return group.capabilities.some((c) => c.capability === 'livetv_high_priority');
    }

    // Server returns { items: AccessGroup[], page } for collection endpoints.
    const AccessGroupListSchema = z.object({
        items: z.array(z.unknown()),
        page: z.object({ limit: z.number(), offset: z.number().optional(), hasMore: z.boolean() }),
    });
    const AccessGroupSchema = z.object({}).passthrough();

    async function refresh(): Promise<void> {
        loading = true;
        const { data, error } = await apiGet('/api/admin/access/groups', AccessGroupListSchema);
        loading = false;
        if (error) {
            toasts.error(error);
        } else {
            groups = (data?.items ?? []) as AccessGroup[];
        }
    }

    async function createGroup(): Promise<void> {
        const name = newName.trim();
        if (!name || creating) return;
        creating = true;
        const { error } = await apiPost('/api/admin/access/groups', AccessGroupSchema, { name });
        creating = false;
        if (error) {
            toasts.error(error);
        } else {
            newName = '';
            toasts.success(`Group "${name}" created`);
            await refresh();
        }
    }

    /** Build the full capability list from the current group's UI state. */
    function buildCapabilities(
        group: AccessGroup,
        change: { cap: AccessCapability; on?: boolean; value?: string | null },
    ): { capability: AccessCapability; value?: string | null }[] {
        // Start from existing caps minus the one being changed, then re-add if on.
        const kept = group.capabilities
            .filter((c) => c.capability !== change.cap)
            .map((c) => ({ capability: c.capability, value: c.value ?? null }));

        if (change.cap === 'max_age_rating') {
            if (change.value && change.value.trim() !== '') {
                kept.push({ capability: 'max_age_rating', value: change.value });
            }
        } else if (change.on) {
            kept.push({ capability: change.cap, value: change.value ?? null });
        }
        return kept;
    }

    // Server returns { items: AccessGroupMember[], page } for members collection.
    const AccessGroupMembersSchema = z.object({
        items: z.array(z.unknown()),
        page: z.object({ limit: z.number(), offset: z.number().optional(), hasMore: z.boolean() }),
    });

    async function saveCapabilities(
        group: AccessGroup,
        change: { cap: AccessCapability; on?: boolean; value?: string | null },
    ): Promise<void> {
        if (savingCapabilities || loading) return;
        savingCapabilities = true;
        const capabilities = buildCapabilities(group, change);
        const { error } = await apiPatch(
            `/api/admin/access/groups/${group.id}`,
            AccessGroupSchema,
            { capabilities },
        );
        if (error) {
            toasts.error(error);
        } else {
            await refresh();
        }
        savingCapabilities = false;
    }

    async function deleteGroup(group: AccessGroup): Promise<void> {
        if (group.isSystem) return;
        if (!confirm(`Delete group "${group.displayName}"? Members lose its capabilities.`)) return;
        const { error } = await apiDelete(
            `/api/admin/access/groups/${group.id}`,
            AccessGroupSchema,
        );
        if (error) {
            toasts.error(error);
        } else {
            if (selectedGroupId === group.id) selectedGroupId = null;
            toasts.success('Group deleted');
            await refresh();
        }
    }

    async function openMembers(group: AccessGroup): Promise<void> {
        if (userSearchTimer) {
            clearTimeout(userSearchTimer);
            userSearchTimer = null;
        }
        const request = ++memberRequest;
        searchRequest++;
        userSearchLoading = false;
        selectedGroupId = group.id;
        membersLoading = true;
        members = [];
        userSearchQuery = '';
        userSearchResults = [];
        const { data, error } = await apiGet(
            `/api/admin/access/groups/${group.id}/members`,
            AccessGroupMembersSchema,
        );
        if (request !== memberRequest || selectedGroupId !== group.id) return;
        membersLoading = false;
        if (error) {
            toasts.error(error);
        } else {
            members = (data?.items ?? []) as AccessGroupMember[];
        }
    }

    // Server returns { items: [{id, username}][], page } for user search.
    const UserSearchResponseSchema = z.object({
        items: z.array(z.unknown()),
        page: z.object({ limit: z.number(), offset: z.number().optional(), hasMore: z.boolean() }),
    });

    function onUserSearchInput(): void {
        if (userSearchTimer) clearTimeout(userSearchTimer);
        const request = ++searchRequest;
        const groupId = selectedGroupId;
        userSearchActiveIndex = -1;
        userSearchLoading = false;
        userSearchResults = [];
        userSearchError = null;
        const q = userSearchQuery.trim();
        if (q.length < 2) {
            userSearchResults = [];
            return;
        }
        userSearchLoading = true;
        userSearchTimer = setTimeout(async () => {
            const { data, error } = await apiGet(
                `/api/users/search?q=${encodeURIComponent(q)}`,
                UserSearchResponseSchema,
            );
            if (request !== searchRequest || groupId !== selectedGroupId) return;
            userSearchLoading = false;
            if (error) {
                userSearchError = error;
                return;
            }
            // Exclude users already in the group
            const existingIds = new Set(members.map((m) => m.userId));
            userSearchResults = ((data?.items ?? []) as UserSearchResult[]).filter(
                (u) => !existingIds.has(u.id),
            );
        }, 250);
    }

    function onUserSearchKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            searchRequest++;
            if (userSearchTimer) clearTimeout(userSearchTimer);
            userSearchLoading = false;
            userSearchResults = [];
            userSearchActiveIndex = -1;
            return;
        }
        const count = userSearchResults.length;
        if (count === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            userSearchActiveIndex = (userSearchActiveIndex + 1) % count;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            userSearchActiveIndex = (userSearchActiveIndex - 1 + count) % count;
        } else if (e.key === 'Enter' && userSearchActiveIndex >= 0) {
            e.preventDefault();
            const user = userSearchResults[userSearchActiveIndex];
            if (user) void addMemberById(user.id);
        }
    }

    async function addMemberById(userId: string): Promise<void> {
        if (!userId || !selectedGroupId || addingMember || membersLoading) return;
        const groupId = selectedGroupId;
        addingMember = true;
        const { error } = await apiPut(
            `/api/admin/access/groups/${selectedGroupId}/members/${encodeURIComponent(userId)}`,
            NoContentSchema,
        );
        addingMember = false;
        if (error) {
            toasts.error(error);
        } else {
            if (selectedGroupId === groupId) {
                userSearchQuery = '';
                userSearchResults = [];
                userSearchActiveIndex = -1;
                const group = selectedGroup;
                if (group) await openMembers(group);
            }
            await refresh();
        }
    }

    async function removeMember(userId: string): Promise<void> {
        if (!selectedGroupId || membersLoading || removingMember) return;
        removingMember = true;
        const groupId = selectedGroupId;
        const { error } = await apiDelete(
            `/api/admin/access/groups/${selectedGroupId}/members/${encodeURIComponent(userId)}`,
            NoContentSchema,
        );
        if (error) {
            toasts.error(error);
        } else {
            if (selectedGroupId === groupId && selectedGroup) await openMembers(selectedGroup);
            await refresh();
        }
        removingMember = false;
    }

    const ACCESS_PAGE_HREF = '/admin/settings/access';

    // ─────────────────────────────────────────────────────────────────────────
    // "Group-based rules" panel — aggregate AUDIT VIEW of every setting whose
    // value references auth/user groups (uiHints.groups, see schema.ts and
    // getGroupReferencingSettings). This is a second, unrelated group concept from
    // the in-app Access Groups above: those are Lumastra-native groups with
    // capabilities; these settings gate features by EXTERNAL IdP group name
    // (forward-auth GROUPHEADER / OIDC groups claim). Each tagged setting still
    // lives — and saves — on its own feature section (e.g.
    // LIVETV_HIGH_PRIORITY_GROUPS stays conceptually part of Live TV); this panel
    // only aggregates them so "what do my groups control?" has one answer. Edits
    // save through the exact same ?/save action (saveSettingsAction) every other
    // settings page uses — there is only ever one settings.json write path, and it
    // does not validate which page a key "belongs" to (see settings-helpers.ts).
    //
    // Settings whose OWN section renders on this page (groups/auth/social) are
    // excluded: they are already on screen a few hundred pixels up, and rendering
    // them twice would emit duplicate `id="setting-<KEY>"` nodes — breaking the
    // deep-link scroll target and producing invalid HTML. What remains is exactly
    // the useful part of the audit: group rules that live SOMEWHERE ELSE.
    const groupSettings: SettingDefinition[] = getGroupReferencingSettings().filter(
        (s) => getPageForSection(s.section)?.href !== ACCESS_PAGE_HREF,
    );

    // Deliberately ungated by the page-level "Show advanced" toggle — this whole
    // panel bypasses advanced/devOnly filtering in SettingSection (settingsOverride)
    // because it IS the audit view: an advanced-tagged group setting (e.g.
    // AGE_RATING_GROUP_PREFIX) must still show up here.
    const groupRulesSection: SectionDefinition = {
        id: 'group-rules',
        label: m.admin_access_group_rules_heading(),
        description: m.admin_access_group_rules_description(),
        order: 0,
    };

    // Origin chip target per source section, resolved from the canonical
    // section→page registry (`admin-settings-pages.ts`) instead of a hardcoded map.
    // The map went stale the moment a section moved page; the registry is the same
    // source cross-page search deep-links use, so a chip can never point at a page
    // that no longer renders the setting. Orphan sections (e.g. `requests`, which
    // no settings page loads) resolve to undefined and simply get no chip.
    function originChipFor(
        setting: SettingDefinition,
    ): { label: string; href: string } | undefined {
        const origin = getPageForSection(setting.section);
        return origin ? { label: origin.label, href: origin.href } : undefined;
    }

    let groupSectionCollapsed = $state(false);

    // Empty state: hide the whole panel when nothing tagged is currently visible
    // (respects each setting's own showWhen/dependsOn — e.g. LIVETV_HIGH_PRIORITY_GROUPS
    // only applies when Live TV's source is "standalone").
    function visibleGroupSettingsCount(values: Record<string, unknown>): number {
        return groupSettings.filter((s) => isSettingVisible(s, values)).length;
    }
</script>

<svelte:head>
    <title>{m.admin_nav_page_settings_access()}</title>
</svelte:head>

<AdminSettingsPage
    {data}
    {form}
    icon={adminPageIcons['/admin/settings/access']}
    heading={m.admin_nav_page_settings_access()}
    description={m.admin_nav_desc_settings_access()}>
    {#snippet beforeSections()}
        <!-- In-app access groups: the page's primary subject, above the config
             sections that describe how external identity maps onto them. -->
        <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
                <h3 class="text-lg font-medium text-surface-200">Access Groups</h3>
                <p class="text-hint mt-0.5">
                    In-app groups, capabilities, and membership — no external identity provider
                    required. Groups created here can also be used as sharing audiences under
                    Settings → Sharing & Privacy.
                </p>
            </div>
            <button
                class="btn variant-soft"
                onclick={refresh}
                disabled={loading || savingCapabilities}>
                <Icon src={ArrowPath} class="h-4 w-4" />
                <span>Refresh</span>
            </button>
        </div>

        <!-- Create -->
        <div class="card p-4 mt-4">
            <form
                class="flex flex-wrap items-end gap-2"
                onsubmit={(e) => {
                    e.preventDefault();
                    void createGroup();
                }}>
                <label class="label flex-1 min-w-48">
                    <span>New group name</span>
                    <input
                        class="input"
                        type="text"
                        bind:value={newName}
                        placeholder="e.g. livetv-cohort" />
                </label>
                <button
                    class="btn variant-filled-primary"
                    type="submit"
                    disabled={creating || !newName.trim()}>
                    <Icon src={Plus} class="h-4 w-4" />
                    <span>Create group</span>
                </button>
            </form>
        </div>

        <!-- Groups list -->
        <div class="mt-4 space-y-3">
            {#each groups as group (group.id)}
                <div class="card p-4">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <h3 class="h4">
                                {group.displayName}
                                {#if group.isSystem}
                                    <span class="badge variant-soft-secondary">system</span>
                                {/if}
                            </h3>
                            <p class="text-sm opacity-70">
                                name: <code>{group.name}</code> · {group.memberCount} member{group.memberCount ===
                                1
                                    ? ''
                                    : 's'}
                            </p>
                            {#if group.isSystem && group.name === 'admins'}
                                <!-- This system group's member count is easy to misread as
                                     "no admins exist" — the built-in admin usually gets in via
                                     an Admin Group match (config.ADMIN_GROUPS), not by being
                                     added here explicitly. Both paths independently confer
                                     admin (access-control.service.ts / auth.ts). -->
                                <p class="text-xs text-surface-500 mt-0.5">
                                    {m.admin_access_admins_group_hint()}
                                </p>
                            {/if}
                        </div>
                        <div class="flex gap-2">
                            <button
                                class="btn btn-sm variant-soft"
                                onclick={() => void openMembers(group)}>
                                Members
                            </button>
                            {#if !group.isSystem}
                                <button
                                    class="btn btn-sm variant-soft-error"
                                    onclick={() => void deleteGroup(group)}
                                    aria-label="Delete group">
                                    <Icon src={Trash} class="h-4 w-4" />
                                </button>
                            {/if}
                        </div>
                    </div>

                    <!-- Capability toggles -->
                    <fieldset
                        disabled={savingCapabilities || loading}
                        class="mt-3 flex flex-wrap gap-4">
                        {#each visibleCaps as cap (cap.key)}
                            <label class="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    class="checkbox"
                                    checked={hasCap(group, cap.key)}
                                    onchange={(e) => {
                                        const on = e.currentTarget.checked;
                                        e.currentTarget.checked = hasCap(group, cap.key);
                                        void saveCapabilities(group, { cap: cap.key, on });
                                    }} />
                                <span>{cap.label}</span>
                            </label>
                        {/each}

                        <label class="flex items-center gap-2 text-sm">
                            <span>Max age rating</span>
                            <input
                                type="number"
                                min="0"
                                class="input w-20"
                                value={ageCap(group)}
                                onchange={(e) => {
                                    const value = e.currentTarget.value;
                                    e.currentTarget.value = ageCap(group);
                                    void saveCapabilities(group, { cap: 'max_age_rating', value });
                                }} />
                        </label>

                        <label class="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                class="checkbox"
                                checked={priorityHigh(group)}
                                onchange={(e) => {
                                    const on = e.currentTarget.checked;
                                    e.currentTarget.checked = priorityHigh(group);
                                    void saveCapabilities(group, {
                                        cap: 'livetv_high_priority',
                                        on,
                                    });
                                }} />
                            <span>Live TV high priority</span>
                        </label>
                    </fieldset>

                    <!-- Members panel (inline when selected) -->
                    {#if selectedGroupId === group.id}
                        <div class="mt-4 border-t border-surface-500/30 pt-3">
                            <h4 class="h5 mb-2">Members</h4>

                            <!-- User search / autocomplete -->
                            <div class="relative flex-1 min-w-64 mb-3">
                                <div
                                    class="flex items-center gap-2 bg-surface-700 border border-surface-600 rounded-lg px-3 py-2">
                                    <Icon
                                        src={MagnifyingGlass}
                                        class="h-4 w-4 text-surface-400 shrink-0" />
                                    <input
                                        class="bg-transparent flex-1 text-sm outline-none placeholder:text-surface-500"
                                        type="text"
                                        role="combobox"
                                        aria-label="Search users to add"
                                        aria-autocomplete="list"
                                        aria-expanded={userSearchResults.length > 0}
                                        aria-controls={USER_SEARCH_LISTBOX_ID}
                                        aria-activedescendant={userSearchActiveIndex >= 0
                                            ? `user-opt-${userSearchResults[userSearchActiveIndex]?.id}`
                                            : undefined}
                                        bind:value={userSearchQuery}
                                        oninput={(event) => {
                                            userSearchQuery = event.currentTarget.value;
                                            onUserSearchInput();
                                        }}
                                        onkeydown={onUserSearchKeydown}
                                        placeholder="Search by name or username…"
                                        autocomplete="off" />
                                    {#if userSearchLoading}
                                        <span
                                            class="w-3 h-3 border border-surface-400 border-t-transparent rounded-full animate-spin shrink-0"
                                        ></span>
                                    {/if}
                                </div>
                                {#if userSearchResults.length > 0}
                                    <ul
                                        id={USER_SEARCH_LISTBOX_ID}
                                        class="absolute z-10 top-full left-0 right-0 mt-1 bg-surface-700 border border-surface-600 rounded-lg shadow-xl max-h-52 overflow-y-auto"
                                        role="listbox"
                                        aria-label="User suggestions">
                                        {#each userSearchResults as user, idx (user.id)}
                                            <li
                                                id="user-opt-{user.id}"
                                                role="option"
                                                aria-selected={idx === userSearchActiveIndex}>
                                                <button
                                                    type="button"
                                                    class="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface-600 transition-colors text-left {idx ===
                                                    userSearchActiveIndex
                                                        ? 'bg-surface-600'
                                                        : ''}"
                                                    disabled={addingMember}
                                                    onclick={() => void addMemberById(user.id)}>
                                                    <span class="font-medium">{user.username}</span>
                                                    <span
                                                        class="text-xs text-surface-400 flex items-center gap-1">
                                                        <Icon src={Plus} class="h-3 w-3" /> Add
                                                    </span>
                                                </button>
                                            </li>
                                        {/each}
                                    </ul>
                                {:else if userSearchError}
                                    <div
                                        role="alert"
                                        class="absolute z-10 top-full left-0 right-0 mt-1 bg-surface-700 border border-red-800/60 rounded-lg px-3 py-2 text-sm text-red-300 shadow-xl">
                                        {userSearchError}
                                    </div>
                                {:else if userSearchQuery.trim().length >= 2 && !userSearchLoading}
                                    <div
                                        class="absolute z-10 top-full left-0 right-0 mt-1 bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-sm text-surface-400 shadow-xl">
                                        No users found for "{userSearchQuery}"
                                    </div>
                                {/if}
                            </div>

                            {#if membersLoading}
                                <p class="text-sm opacity-70">Loading members…</p>
                            {:else if members.length === 0}
                                <p class="text-sm opacity-70">No members yet.</p>
                            {:else}
                                <ul class="space-y-1">
                                    {#each members as member (member.userId)}
                                        <li class="flex items-center justify-between gap-2 text-sm">
                                            <span>
                                                {member.displayName ?? member.username}
                                                <code class="opacity-60">{member.userId}</code>
                                            </span>
                                            <button
                                                class="btn btn-sm variant-soft-error"
                                                onclick={() => void removeMember(member.userId)}
                                                aria-label="Remove member"
                                                disabled={removingMember}>
                                                <Icon src={XMark} class="h-4 w-4" />
                                            </button>
                                        </li>
                                    {/each}
                                </ul>
                            {/if}
                        </div>
                    {/if}
                </div>
            {/each}

            {#if groups.length === 0}
                <p class="opacity-70">No access groups yet. Create one above.</p>
            {/if}
        </div>
    {/snippet}

    {#snippet sectionSnippet({ sectionId })}
        <!-- Companion panels travel with their sections (both moved here from the
             general settings page). -->
        {#if sectionId === 'auth'}
            <div class="mt-4">
                <AuthDiagnosticsPanel />
            </div>
        {:else if sectionId === 'push'}
            <div class="mt-4" role="status">
                <p
                    class={data.apnsStatus?.kind === 'invalid'
                        ? 'text-red-400'
                        : data.apnsStatus?.kind === 'warning'
                          ? 'text-amber-400'
                          : 'text-surface-200'}>
                    {#if data.apnsStatus?.kind === 'invalid'}
                        {m.admin_push_invalid({ reason: data.apnsStatus.reason })}
                    {:else if data.apnsStatus?.kind === 'warning'}
                        {m.admin_push_warning({ reason: data.apnsStatus.reason })}
                    {:else if data.apnsStatus?.kind === 'ready'}
                        {m.admin_push_configured()}
                    {:else}
                        {m.admin_push_absent()}
                    {/if}
                </p>
                <p class="mt-1 text-sm text-surface-400">{m.admin_push_direct_help()}</p>
            </div>
        {:else if sectionId === 'social'}
            <ActivitySharingDefaultPanel />
            <SocialAudiencePanel />
        {/if}
    {/snippet}

    {#snippet afterSections({ currentValues, envOverridesSet, handleChange })}
        <!-- Group-based rules: aggregate audit view of every setting keyed off an
             external auth-provider group name (not the in-app Access Groups above)
             whose own section lives on ANOTHER page. Edits flow into the page's
             single settings form via handleChange, so the shared sticky save bar
             covers them — no second save path, and no risk of the two clobbering
             each other's payload. -->
        {#if visibleGroupSettingsCount(currentValues) > 0}
            <div class="mt-6">
                <SettingSection
                    section={groupRulesSection}
                    values={currentValues}
                    envOverrides={envOverridesSet}
                    settingsOverride={groupSettings}
                    {originChipFor}
                    bind:collapsed={groupSectionCollapsed}
                    onchange={(detail) => handleChange(detail.key, detail.value)} />
            </div>
        {/if}
    {/snippet}
</AdminSettingsPage>
