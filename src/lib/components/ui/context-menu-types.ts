// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Entry types for ContextMenu.svelte.
 *
 * These live in a plain module rather than the component's `<script module>`
 * because plain `.ts` files cannot import named types out of a `.svelte`
 * file — the ambient `*.svelte` module declaration shadows the real exports,
 * so the menu builders in `music-track-menu.ts` / `add-to-playlist-menu.ts`
 * would not typecheck.
 *
 * Import them from HERE, never from `ContextMenu.svelte`. This block used to
 * promise the component re-exported them so old import paths kept working; it
 * does not, and by the paragraph above such a re-export could not have helped
 * a `.ts` importer anyway. Nothing imports these from the component today.
 */
import type { Component } from 'svelte';
import type { IconSource } from 'svelte-hero-icons';

export interface ContextMenuItem {
    label: string;
    icon?: IconSource;
    onSelect: () => void;
    destructive?: boolean;
    /** When true, the entry is filtered out when the menu renders
     * as a mobile bottom sheet. Use for actions that don't fit the
     * mobile context (admin shortcuts, legacy-client deeplinks,
     * etc.). Desktop right-click still surfaces them. */
    hideOnMobile?: boolean;
}

/** A single icon-button inside an ActionRow. */
export interface ContextMenuRowAction {
    icon: IconSource;
    /** Tooltip / aria-label */
    label: string;
    /** Active visual state — for like/dislike "already chosen" styling */
    active?: boolean;
    /** Optional accent class applied when the button is hovered or active */
    accent?: 'positive' | 'negative' | 'love' | 'neutral';
    onSelect: () => void;
}

/** Full-width row of icon-buttons (e.g. dislike / like / love). */
export interface ContextMenuActionRow {
    kind: 'actions';
    actions: ContextMenuRowAction[];
    /** Same semantic as ContextMenuItem.hideOnMobile. */
    hideOnMobile?: boolean;
}

/** Props every submenu panel component receives from ContextMenu. */
export interface ContextMenuSubmenuProps {
    /** Call once an action commits — closes the whole menu. */
    onDone: () => void;
}

/** A submenu panel as ContextMenu sees it: props type-erased, because the
 *  menu holds a heterogeneous list of entries and cannot carry each panel's
 *  own prop type through it. */
export type ContextMenuSubmenuComponent = Component<
    ContextMenuSubmenuProps & Record<string, unknown>
>;

/** Entry that opens a nested panel instead of firing an action.
 *
 * The panel body is a component (not a list of items) so callers can
 * render richer content than menu rows — the add-to-playlist flyout
 * pairs a scrollable list with an inline "new playlist" text field.
 *
 * The component receives `onDone` and must call it once the user has
 * committed an action, which closes the whole menu. */
export interface ContextMenuSubmenu {
    kind: 'submenu';
    label: string;
    icon?: IconSource;
    /** Panel body. Rendered with `props` plus an injected `onDone`.
     *  Build this pair with `submenuComponent()` — it checks the props
     *  against the component before erasing them. */
    component: ContextMenuSubmenuComponent;
    /** Extra props forwarded to `component`. */
    props?: Record<string, unknown>;
    /** Same semantic as ContextMenuItem.hideOnMobile. */
    hideOnMobile?: boolean;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuActionRow | ContextMenuSubmenu;

export function isActionRow(entry: ContextMenuEntry): entry is ContextMenuActionRow {
    return (entry as ContextMenuActionRow).kind === 'actions';
}

export function isSubmenu(entry: ContextMenuEntry): entry is ContextMenuSubmenu {
    return (entry as ContextMenuSubmenu).kind === 'submenu';
}

/**
 * Pairs a submenu panel component with its props, checking them against the
 * component's own Props type, then erases that type for storage in a
 * ContextMenuSubmenu. The cast is the single point where the pairing stops
 * being checked, which is why constructing the pair by hand is discouraged.
 */
export function submenuComponent<P extends Record<string, unknown>>(
    component: Component<P & ContextMenuSubmenuProps>,
    props: P,
): Pick<ContextMenuSubmenu, 'component' | 'props'> {
    return {
        component: component as unknown as ContextMenuSubmenuComponent,
        props,
    };
}
