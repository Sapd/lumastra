// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Centralized z-index scale for Lumastra.
 *
 * Layer hierarchy (low → high):
 *
 * | Constant               | Value  | Purpose                                               |
 * |------------------------|--------|-------------------------------------------------------|
 * | SIDEBAR_DOCK           |    100 | Fixed sidebar / dock                                  |
 * | SIDEBAR_DOCK_BUTTON    |    101 | Dock toggle button                                    |
 * | TOC                    |    110 | Right-side section index (TableOfContents)            |
 * | NAVBAR                 |    500 | Main navigation bar (desktop fixed)                   |
 * | NAV_PROGRESS           |    501 | Top loading bar (sits above the transparent navbar)   |
 * | NAV_POPUP              |    550 | Popups anchored to navbar/footer (user menu, etc.)    |
 * | BOTTOM_NAV             |    590 | Music mobile bottom tab bar (below MiniPlayer bar)    |
 * | MUSIC_BAR              |    600 | Persistent music mini-player bar                      |
 * | MUSIC_QUEUE            |    601 | Music queue panel                                     |
 * | MUSIC_FULLSCREEN       |    950 | Full-screen music player (modals appear above it)     |
 * | SETTINGS_OVERLAY       |    980 | /settings overlay (below MODAL so its dialogs stack above) |
 * | MEDIA_HOVER_PREVIEW    |    990 | Media card hover-preview popup — pinned below MODAL so an open modal can never be covered by a stale preview |
 * | MODAL                  |   1000 | Modal system base (ModalContainer manages stack)      |
 * | MUSIC_OVER_MODAL       |   1050 | MiniPlayer/QueuePanel lifted above open music modal   |
 * | MUSIC_OVER_MODAL_POPUP |   1051 | Hover cards spawned FROM the lifted MiniPlayer/queue  |
 * | MUSIC_SHEET            |   1100 | Music chapter sheet — standalone, above modals        |
 * | MUSIC_SHEET_CONTENT    |   1101 | Music chapter sheet content layer                     |
 * | ADMIN_BANNER           |   1200 | Admin / maintenance banners                           |
 * | TOAST                  |   1300 | Toast notifications                                   |
 * | SEARCH                 |   1500 | Search overlay (fullscreen, above toasts)             |
 * | FLOATING_MODAL         |   1600 | Modals spawned from search or context-menu context    |
 * | TOOLTIP                |   2000 | Tooltips / hover previews                             |
 * | CTX_MENU_BACKDROP      |   2999 | Context menu backdrop                                 |
 * | CTX_MENU               |   3000 | Context menus                                         |
 * | PLAYER                 |   9000 | Fullscreen player (watch page takes over viewport)    |
 * | PLAYER_TOAST           |   9500 | Toasts rendered inside the player                     |
 * | PLAYER_SIDEBAR         |  10000 | Player sidebar panel                                  |
 * | PLAYER_SIDEBAR_CONTENT |  10001 | Player sidebar content layer                          |
 * | PLAYER_ANNOTATIONS     |  10010 | Player annotations overlay                            |
 * | MODAL_OVER_PLAYER      |  10050 | Modal layer lifted above the player tier (see below)   |
 * | SYSTEM_OVERLAY         |  10100 | Critical system overlays (auth expiry, splash screen) |
 *
 * NOTE: CSS/Svelte style blocks cannot import TS constants — use raw numbers
 * in CSS that must match these values and cite the constant name in a comment.
 */
export const Z = {
    // Fixed page elements
    SIDEBAR_DOCK: 100,
    SIDEBAR_DOCK_BUTTON: 101,
    TOC: 110, // right-side section index (TableOfContents)

    // Main navigation
    NAVBAR: 500,

    // Top loading bar (NavigationProgressBar) — must sit above the transparent navbar
    NAV_PROGRESS: 501,

    // Popups anchored to the navbar/footer (user menu, quick connect, etc.)
    NAV_POPUP: 550,

    // Music bottom tab bar (mobile only). Below MUSIC_BAR so the MiniPlayer
    // docks visually above it, and far below MODAL (1000) so a music modal's
    // backdrop covers the bar.
    BOTTOM_NAV: 590,

    // Persistent music UI
    MUSIC_BAR: 600,
    MUSIC_QUEUE: 601,

    // Full-screen music player (covers viewport; modals appear above it)
    MUSIC_FULLSCREEN: 950,

    // Full-screen user-settings overlay (deep-linkable /settings route).
    // Opaque; covers page chrome, the real mini-player (z-40) and nav popups,
    // but sits BELOW the modal tier on purpose so dialogs opened from WITHIN
    // settings (token-create, Jellyfin/Subsonic connect, change-password) stack
    // ABOVE it and the layout's hasModals/Esc arbitration works. Below toasts
    // (1300) and the fullscreen player tier (9000+).
    SETTINGS_OVERLAY: 980,

    // Media card hover-preview popup (MediaHoverCard). Deliberately BELOW
    // MODAL — the popup portal is a global <body> child, so if it were ever
    // left showing (race) at the moment a modal opens, it must not be able
    // to paint above the modal's backdrop/content.
    MEDIA_HOVER_PREVIEW: 990,

    // Modal system (ModalContainer manages its stack: backdrop = MODAL + index, panel = MODAL + 1 + index)
    MODAL: 1000,

    // MiniPlayer / QueuePanel lifted above the modal layer when a music modal is open
    MUSIC_OVER_MODAL: 1050,

    // Hover cards (artist/album summaries) spawned FROM the lifted MiniPlayer or
    // queue. They portal to <body>, so MEDIA_HOVER_PREVIEW (990, deliberately
    // below MODAL) would paint them behind an open modal's backdrop even though
    // their trigger bar sits above it at MUSIC_OVER_MODAL.
    MUSIC_OVER_MODAL_POPUP: 1051,

    // Music chapter sheet (standalone, above modals)
    MUSIC_SHEET: 1100,
    MUSIC_SHEET_CONTENT: 1101,

    // Admin / maintenance banners
    ADMIN_BANNER: 1200,

    // Toast notifications
    TOAST: 1300,

    // Search overlay (fullscreen, above toasts)
    SEARCH: 1500,

    // Modals spawned from search or context-menu context (must beat Search overlay)
    FLOATING_MODAL: 1600,

    // Tooltips / hover previews
    TOOLTIP: 2000,

    // Context menus
    CTX_MENU_BACKDROP: 2999,
    CTX_MENU: 3000,

    // === Fullscreen player tier (watch page takes over viewport) ===
    PLAYER: 9000,
    PLAYER_TOAST: 9500,
    PLAYER_SIDEBAR: 10000,
    PLAYER_SIDEBAR_CONTENT: 10001,
    PLAYER_ANNOTATIONS: 10010,

    // ModalContainer's layer lifted above the WHOLE player tier.
    //
    // The player tier is a root-level `position: fixed` stacking context at
    // PLAYER (9000) — `.watch-page`, and `.player-container` for embedded
    // shells. The modal layer is a SIBLING root-level context at MODAL
    // (1000), so a modal opened from inside the player (e.g. a search result
    // -> ModalMovie) paints BEHIND the video: mounted, invisible, and
    // impossible to dismiss, which then wedges every consumer that keys off
    // `hasModals` (Search auto-hides itself for as long as a modal is open).
    //
    // ModalContainer switches its layer to this value for exactly as long as
    // a player surface is mounted. It cannot be the unconditional base: the
    // MUSIC_OVER_MODAL / MUSIC_SHEET / ADMIN_BANNER / TOAST / SEARCH /
    // FLOATING_MODAL / TOOLTIP / CTX_MENU tiers are all deliberately ABOVE
    // MODAL and would invert if the modal layer moved up globally.
    //
    // Above PLAYER_ANNOTATIONS (10010) so it beats the player's own sidebars
    // and overlays; below SYSTEM_OVERLAY so auth-expiry still wins.
    MODAL_OVER_PLAYER: 10050,

    // Critical system overlays (auth expiry, splash) — above everything
    SYSTEM_OVERLAY: 10100,
} as const;

export type ZLayer = keyof typeof Z;
