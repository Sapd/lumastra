<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { Icon, UserPlus, XMark } from 'svelte-hero-icons';
    import type { PlaylistMember } from '$lib/types/api-playlists';
    import { displayName } from '$lib/utils/data-extraction';
    import { getAvatarUrl } from '$lib/utils/image-utils';
    import Avatar from '$lib/components/ui/Avatar.svelte';

    interface Props {
        searchQuery?: string;
        /** Search results from /api/users/search — new contract includes stable `id` UUID. */
        searchResults?: Array<{ username: string; id: string }>;
        selectedRole?: 'editor' | 'readonly';
        inviting?: boolean;
        updatingMember?: string | null;
        members?: PlaylistMember[];
        onSearch?: (event: Event) => void;
        /** Called with the invitee's stable UUID (not username). */
        onInvite?: (userId: string) => void;
        onUpdateRole?: (username: string, role: 'editor' | 'readonly') => void;
        onRemove?: (username: string) => void;
        onClose?: () => void;
    }

    let {
        searchQuery = $bindable(''),
        searchResults = [],
        selectedRole = $bindable('readonly'),
        inviting = false,
        updatingMember = null,
        members = [],
        onSearch = () => {},
        onInvite = () => {},
        onUpdateRole = () => {},
        onRemove = () => {},
        onClose = () => {},
    }: Props = $props();

    function handleRoleChange(member: PlaylistMember, event: Event) {
        const target = event.currentTarget as HTMLSelectElement | null;
        if (!target) return;
        const role = target.value === 'editor' ? 'editor' : 'readonly';
        // Keep the confirmed role visible until the parent receives success.
        target.value = member.role;
        onUpdateRole(member.author.userId, role);
    }
</script>

<div class="card p-4 bg-surface-800 mb-6">
    <div class="between mb-4">
        <h3 class="h4">{m.playlist_manage_members()}</h3>
        <button
            type="button"
            class="btn-icon btn-icon-sm variant-ghost-surface"
            onclick={onClose}
            aria-label={m.btn_close()}>
            <Icon src={XMark} class="w-5 h-5" />
        </button>
    </div>

    <div class="flex gap-2 mb-4">
        <div class="flex-1 relative">
            <input
                type="text"
                class="input"
                placeholder={m.playlist_search_username()}
                aria-label={m.playlist_search_username()}
                bind:value={searchQuery}
                oninput={onSearch} />
            {#if searchResults.length > 0}
                <div
                    class="absolute top-full left-0 right-0 mt-1 bg-surface-700 rounded-lg shadow-xl border border-surface-600 max-h-48 overflow-y-auto z-10">
                    {#each searchResults as user (user.username)}
                        <button
                            type="button"
                            class="w-full px-4 py-2 text-left hover:bg-surface-600 between"
                            onclick={() => onInvite(user.id)}
                            disabled={inviting}>
                            <div class="flex items-center gap-2">
                                <Avatar
                                    size="2xs"
                                    username={user.username}
                                    src={getAvatarUrl(user.username)}
                                    initials={user.username.slice(0, 1).toUpperCase()}
                                    alt={user.username} />
                                <span>{displayName(user.username)}</span>
                            </div>
                            <Icon src={UserPlus} class="w-4 h-4 text-primary-400" />
                        </button>
                    {/each}
                </div>
            {/if}
        </div>
        <select
            class="select w-32"
            bind:value={selectedRole}
            aria-label={m.viewer_playlist_invitation_role()}>
            <option value="readonly">{m.playlist_readonly()}</option>
            <option value="editor">{m.playlist_editor()}</option>
        </select>
    </div>

    <div class="space-y-2">
        {#each members as member (member.author.userId)}
            <div
                class="between p-2 bg-surface-700 rounded-lg {member.status === 'pending'
                    ? 'opacity-70'
                    : ''}">
                <div class="flex items-center gap-3">
                    <Avatar
                        size="xs"
                        username={member.author.userId}
                        src={member.author.images.primary.href}
                        initials={(member.author.displayName ?? '').slice(0, 1).toUpperCase()}
                        alt={member.author.userId} />
                    <div class="flex flex-col">
                        <span class="font-medium">{member.author.displayName ?? ''}</span>
                        {#if member.status === 'pending'}
                            <span class="text-xs text-warning-400"
                                >{m.playlist_invitation_pending()}</span>
                        {/if}
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <select
                        class="select select-sm"
                        value={member.role}
                        aria-label={`${m.viewer_playlist_member_role()}: ${member.author.displayName ?? ''}`}
                        onchange={(e) => handleRoleChange(member, e)}
                        disabled={member.status === 'pending' ||
                            updatingMember === member.author.userId}
                        aria-busy={updatingMember === member.author.userId}>
                        <option value="readonly">{m.playlist_readonly()}</option>
                        <option value="editor">{m.playlist_editor()}</option>
                    </select>
                    <button
                        type="button"
                        class="btn-icon btn-icon-sm variant-ghost-error"
                        onclick={() => onRemove(member.author.userId)}
                        aria-label={m.btn_remove()}
                        title={member.status === 'pending'
                            ? m.playlist_withdraw_invitation()
                            : m.btn_remove()}>
                        <Icon src={XMark} class="w-4 h-4" />
                    </button>
                </div>
            </div>
        {/each}
        {#if members.length === 0}
            <p class="text-surface-500 text-sm text-center py-4">
                {m.playlist_no_members()}
            </p>
        {/if}
    </div>
</div>
