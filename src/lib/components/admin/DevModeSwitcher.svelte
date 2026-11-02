<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { toasts } from '$lib/stores/toast.store';

    interface Props {
        currentUser?: string;
        defaultUser?: string; // Configurable default from server
        onUserChange?: ((user: string) => void) | null;
        // Callbacks
        onuserChange?: (user: string) => void;
    }

    let {
        currentUser = $bindable('admin'),
        defaultUser = 'admin',
        onUserChange = null,
        onuserChange,
    }: Props = $props();

    let showUserSwitcher = $state(false);
    let inputValue = $derived(currentUser);

    function switchUser() {
        // Store user in localStorage and set cookie for backend
        localStorage.setItem('devUser', inputValue);
        document.cookie = `devUser=${encodeURIComponent(inputValue)}; path=/; max-age=${60 * 60 * 24 * 7}`; // 7 days

        toasts.show(`🔄 Dev Mode: Switched to user "${inputValue}"`, 'info', 3000);
        showUserSwitcher = false;
        currentUser = inputValue;

        // Notify parent
        onuserChange?.(inputValue);
        if (onUserChange) onUserChange(inputValue);
    }

    function resetToDefault() {
        inputValue = defaultUser;
        currentUser = defaultUser;
        localStorage.removeItem('devUser');
        document.cookie = 'devUser=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT';
        toasts.show(`🔄 Dev Mode: Reset to default user "${defaultUser}"`, 'info', 3000);

        // Notify parent
        onuserChange?.(defaultUser);
        if (onUserChange) onUserChange(defaultUser);
    }
</script>

<div
    class="bg-gradient-to-r from-yellow-900/30 to-orange-900/30 border border-yellow-600/50 rounded-lg p-4">
    <div class="between">
        <div class="flex items-center gap-2">
            <span class="text-yellow-400">⚠️ DEV MODE</span>
            <span class="text-sm text-yellow-200"
                >Current User: <strong>{currentUser}</strong></span>
        </div>
        <div class="flex items-center gap-2">
            <button
                class="text-yellow-400 hover:text-yellow-300 text-sm underline"
                onclick={() => (showUserSwitcher = !showUserSwitcher)}>
                {showUserSwitcher ? 'Hide' : 'Switch User'}
            </button>
            <button
                class="text-orange-400 hover:text-orange-300 text-sm underline"
                onclick={resetToDefault}>
                Reset to Default
            </button>
        </div>
    </div>

    {#if showUserSwitcher}
        <div class="mt-3 pt-3 border-t border-yellow-600/30">
            <div class="flex items-center gap-3">
                <label for="dev-user-input" class="text-sm text-yellow-200">Switch to user:</label>
                <input
                    id="dev-user-input"
                    type="text"
                    bind:value={inputValue}
                    placeholder="Enter username (e.g., Gernot, TestUser)"
                    class="px-3 py-1 bg-surface-800 border border-surface-600 rounded text-white text-sm flex-1 max-w-xs"
                    onkeydown={(e) => e.key === 'Enter' && switchUser()} />
                <button class="btn btn-sm btn-yellow" onclick={switchUser}> Switch </button>
            </div>
            <p class="text-xs text-yellow-300 mt-1">
                💡 This changes the user context for AI recommendations, onboarding, and user
                management. Only visible in development mode.
            </p>
        </div>
    {/if}
</div>
