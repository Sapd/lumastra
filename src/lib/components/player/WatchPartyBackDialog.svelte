<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import './player-presentation.css';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        isOpen?: boolean;
        onclose?: () => void;
        onsearch?: () => void;
        onleave?: () => void;
    }

    let { isOpen = false, onclose, onsearch, onleave }: Props = $props();

    function handleBackdropClick() {
        onclose?.();
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.stopImmediatePropagation();
            onclose?.();
        }
    }

    function handleSearch() {
        onsearch?.();
    }

    function handleLeave() {
        onleave?.();
    }

    function handleCancel() {
        onclose?.();
    }

    // Prevent clicks inside dialog from closing it
    function handleDialogClick(event: MouseEvent) {
        event.stopPropagation();
    }

    // Prevent keydown inside dialog from propagating
    function handleDialogKeydown(event: KeyboardEvent) {
        event.stopPropagation();
    }
</script>

{#if isOpen}
    <div
        class="watch-party-dialog-backdrop"
        onclick={handleBackdropClick}
        onkeydown={handleKeydown}
        role="button"
        tabindex="0"
        aria-label="Close dialog">
        <div
            class="watch-party-dialog player-menu"
            role="dialog"
            aria-modal="true"
            aria-label="Watch party active"
            tabindex="-1"
            onclick={handleDialogClick}
            onkeydown={handleDialogKeydown}>
            <h3>{m.watch_party_active()}</h3>
            <p>{m.watch_party_host_question()}</p>
            <div class="watch-party-dialog-buttons">
                <button class="dialog-btn search" onclick={handleSearch}>
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke-width="1.5"
                        stroke="currentColor"
                        width="20"
                        height="20">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                    </svg>
                    {m.watch_party_search_other()}
                </button>
                <button class="dialog-btn leave" onclick={handleLeave}>
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke-width="1.5"
                        stroke="currentColor"
                        width="20"
                        height="20">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" />
                    </svg>
                    {m.watch_party_end_and_back()}
                </button>
                <button class="dialog-btn cancel" onclick={handleCancel}>
                    {m.cancel()}
                </button>
            </div>
        </div>
    </div>
{/if}

<style>
    .watch-party-dialog-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000; /* Z.PLAYER_SIDEBAR */
        animation: fadeIn 0.2s ease-out;
    }

    @keyframes fadeIn {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }

    .watch-party-dialog {
        padding: 1.5rem;
        max-width: 400px;
        width: 90%;
        text-align: center;
    }

    .watch-party-dialog h3 {
        font-size: 1.25rem;
        font-weight: 600;
        color: white;
        margin-bottom: 0.5rem;
    }

    .watch-party-dialog p {
        color: rgba(255, 255, 255, 0.7);
        font-size: 0.9rem;
        margin-bottom: 1.5rem;
    }

    .watch-party-dialog-buttons {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .dialog-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 0.875rem 1rem;
        border-radius: 10px;
        font-size: 0.9rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        border: none;
    }

    .dialog-btn.search {
        background: linear-gradient(135deg, #3b82f6, #2563eb);
        color: white;
    }

    .dialog-btn.search:hover {
        background: linear-gradient(135deg, #60a5fa, #3b82f6);
        transform: translateY(-1px);
    }

    .dialog-btn.leave {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
        border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .dialog-btn.leave:hover {
        background: rgba(239, 68, 68, 0.25);
    }

    .dialog-btn.cancel {
        background: rgba(255, 255, 255, 0.1);
        color: rgba(255, 255, 255, 0.7);
    }

    .dialog-btn.cancel:hover {
        background: rgba(255, 255, 255, 0.15);
        color: white;
    }
</style>
