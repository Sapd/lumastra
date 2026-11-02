<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script module lang="ts">
    let sequence = 0;
    function nextId(): string {
        sequence += 1;
        return `language-overflow-${sequence}`;
    }
</script>

<script lang="ts">
    import { onDestroy } from 'svelte';
    import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        label: string;
        names: string[];
        hiddenCount: number;
    }
    let { label, names, hiddenCount }: Props = $props();
    const id = nextId();
    let trigger: HTMLButtonElement;
    let open = $state(false);
    let pinned = false;
    let focused = false;
    let restoringFocus = false;
    let popupElement: HTMLElement | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;

    function close(): void {
        clearTimeout(closeTimer);
        pinned = false;
        focused = false;
        open = false;
    }
    function preview(): void {
        clearTimeout(closeTimer);
        open = true;
    }
    function leave(): void {
        if (!pinned && !focused) closeTimer = setTimeout(close, 120);
    }
    function toggle(event: MouseEvent): void {
        event.preventDefault();
        event.stopPropagation();
        if (pinned) close();
        else {
            pinned = true;
            preview();
        }
    }
    function portal(node: HTMLElement): { destroy: () => void } {
        popupElement = node;
        const fullscreen = document.fullscreenElement;
        (fullscreen?.contains(trigger) ? fullscreen : document.body).appendChild(node);
        const cleanup = autoUpdate(trigger, node, () => {
            void computePosition(trigger, node, {
                strategy: 'fixed',
                placement: 'top',
                middleware: [
                    offset(8),
                    flip(),
                    shift({ padding: 8 }),
                    size({
                        padding: 8,
                        apply({ availableHeight, elements }): void {
                            elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
                        },
                    }),
                ],
            }).then(({ x, y }) => {
                Object.assign(node.style, { left: `${x}px`, top: `${y}px`, visibility: 'visible' });
            });
        });
        function outside(event: PointerEvent): void {
            if (!trigger.contains(event.target as Node) && !node.contains(event.target as Node))
                close();
        }
        function escape(event: KeyboardEvent): void {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                const returnFocus = node.contains(document.activeElement);
                close();
                if (returnFocus) {
                    restoringFocus = true;
                    trigger.focus();
                    restoringFocus = false;
                }
            }
        }
        function focusOutside(event: FocusEvent): void {
            if (!trigger.contains(event.target as Node) && !node.contains(event.target as Node))
                close();
        }
        function ownKeys(event: KeyboardEvent): void {
            // Keep arrow-key scrolling from reaching the player's volume shortcuts.
            if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation();
        }
        node.addEventListener('keydown', ownKeys);
        document.addEventListener('fullscreenchange', close);
        document.addEventListener('focusin', focusOutside);
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', escape, true);
        return {
            destroy(): void {
                cleanup();
                popupElement = undefined;
                node.removeEventListener('keydown', ownKeys);
                document.removeEventListener('fullscreenchange', close);
                document.removeEventListener('focusin', focusOutside);
                document.removeEventListener('pointerdown', outside, true);
                document.removeEventListener('keydown', escape, true);
                node.remove();
            },
        };
    }
    onDestroy(() => clearTimeout(closeTimer));
</script>

<button
    bind:this={trigger}
    type="button"
    class="overflow-trigger"
    aria-label={`${label}: ${m.media_languages_more({ count: hiddenCount })}`}
    aria-expanded={open}
    aria-controls={open ? id : undefined}
    onmouseenter={preview}
    onmouseleave={leave}
    aria-describedby={open ? id : undefined}
    onfocus={() => {
        if (!restoringFocus) {
            focused = true;
            preview();
        }
    }}
    onblur={(event) => {
        if (popupElement?.contains(event.relatedTarget as Node)) return;
        focused = false;
        if (!pinned || event.relatedTarget) close();
    }}
    onkeydown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
        if (event.key === 'ArrowDown' && open) {
            event.preventDefault();
            event.stopPropagation();
            popupElement?.focus();
        }
    }}
    onclickcapture={(event) => event.preventDefault()}
    onclick={toggle}>+{hiddenCount}</button>
{#if open}
    <div
        use:portal
        {id}
        role="region"
        tabindex="-1"
        aria-label={label}
        class="language-popover bg-surface-800 text-surface-100 border-surface-600"
        onmouseenter={preview}
        onmouseleave={leave}>
        <strong>{label}</strong>
        <div class="language-names">{names.join(' · ')}</div>
    </div>
{/if}

<style>
    .overflow-trigger {
        flex: none;
        border: 1px solid currentColor;
        border-radius: 0.25rem;
        padding: 0.125rem 0.25rem;
        font-size: 9px;
        font-weight: 700;
        cursor: pointer;
    }
    .overflow-trigger:focus-visible {
        outline: 2px solid currentColor;
        outline-offset: 2px;
    }
    .language-popover {
        position: fixed;
        box-sizing: border-box;
        overflow-y: auto;
        overscroll-behavior: contain;
        z-index: 100001;
        visibility: hidden;
        width: max-content;
        max-width: min(22rem, calc(100vw - 16px));
        padding: 0.75rem;
        border-width: 1px;
        border-radius: 0.5rem;
        box-shadow: 0 8px 24px #0006;
        font-size: 0.75rem;
        line-height: 1.6;
    }
    .language-names {
        margin-top: 0.25rem;
        white-space: normal;
        overflow-wrap: anywhere;
    }
</style>
