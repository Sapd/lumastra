// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lumastra's own hand-rolled nav icons — split out of navigation-icons.ts so
 * client code that only needs THESE (a fixed, non-configurable handful) can
 * import them without dragging in heroicon-catalog.ts's 212-icon spread
 * (navigationIconMap). See src/lib/Sidebar.svelte and
 * src/routes/+layout.server.ts's `resolveNavIcons` for why that split
 * matters: heroicon-catalog.ts is the admin nav icon picker's lookup table,
 * imported by the admin editor (full catalog, fine, admin-only) and by the
 * server (to resolve only the names actually configured, see
 * `resolve-nav-icons.ts`) — never by client code that runs on every route.
 *
 * These are NOT heroicons: no `@steeze-ui/heroicons` import here at all, so
 * nothing in this file is touched by the hero-icon-split Vite plugin.
 */

import type { IconSource } from 'svelte-hero-icons';

// svelte-hero-icons' <Icon> only renders the `path` children of an
// IconSource, so any <rect>/<circle> from the source SVG is expressed as
// path data here. Stroke styling lives on the root `a` attributes (inherited
// by every path) so these icons pick up `currentColor` and theme exactly
// like the built-in set.
const lumastraLineIcon = (paths: string[]): IconSource => ({
    default: {
        a: {
            fill: 'none',
            viewBox: '0 0 24 24',
            stroke: 'currentColor',
            'stroke-width': '2',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
        },
        path: paths.map((d) => ({ d })),
    },
});

// Clapperboard — the default "Requests" icon (lumastra-request-clapperboard.svg).
export const Clapperboard = lumastraLineIcon([
    'M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z',
    'm6.2 5.3 3.1 3.9',
    'm12.4 3.4 3.1 4',
    'M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    'M12 13.9v4.2',
    'M9.9 16h4.2',
]);

// Live TV play (lumastra-livetv-play.svg) — rect → rounded-rect path.
export const LiveTvPlay = lumastraLineIcon([
    'm17 2-5 5-5-5',
    'M4 7h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z',
    'M10 11.5v6l5-3z',
]);

// Radio tower (lumastra-livetv-tower.svg) — radio channels in /music. circle → path.
export const RadioTower = lumastraLineIcon([
    'M4.9 16.1C1 12.2 1 5.8 4.9 1.9',
    'M7.8 4.7a6.14 6.14 0 0 0-.8 7.5',
    'M14 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
    'M16.2 4.8c2 2 2.26 5.11.8 7.47',
    'M19.1 1.9a9.96 9.96 0 0 1 0 14.1',
    'M9.5 18h5',
    'm8 22 4-11 4 11',
]);

// Audiobooks — open book with sound bars (lumastra-audiobooks-bars.svg).
export const Audiobooks = lumastraLineIcon([
    'M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20',
    'M8 8v3',
    'M12 6v7',
    'M16 8v3',
]);

// Books — shelved spines (lumastra-books-library.svg).
export const BooksLibrary = lumastraLineIcon(['m16 6 4 14', 'M12 6v14', 'M8 8v12', 'M4 4v16']);

// Live TV antenna — TV box without the play glyph (lumastra-livetv-antenna.svg).
// rect → rounded-rect path.
export const LiveTvAntenna = lumastraLineIcon([
    'm17 2-5 5-5-5',
    'M4 7h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z',
]);

// Music note — twin noteheads (lumastra-music-note.svg). circles → paths.
export const MusicNote = lumastraLineIcon([
    'M9 18V5l12-2v13',
    'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    'M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
]);

// Music single — single note (lumastra-music-single.svg). circle → path.
export const MusicSingle = lumastraLineIcon([
    'M12 18a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
    'M12 18V2l7 4',
]);

// Music vinyl — record disc (lumastra-music-vinyl.svg). circles → paths.
export const MusicVinyl = lumastraLineIcon([
    'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
    'M6 12c0-1.7.7-3.2 1.8-4.2',
    'M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
    'M18 12c0 1.7-.7 3.2-1.8 4.2',
]);

/** Kebab-case key -> icon, mirroring heroicon-catalog.ts's own key style so
 * stored navigation configs keep resolving regardless of which set an icon
 * name came from. */
export const lumastraCustomIconMap: Record<string, IconSource> = {
    clapperboard: Clapperboard,
    'livetv-play': LiveTvPlay,
    'radio-tower': RadioTower,
    audiobooks: Audiobooks,
    'books-library': BooksLibrary,
    'livetv-antenna': LiveTvAntenna,
    'music-note': MusicNote,
    'music-single': MusicSingle,
    'music-vinyl': MusicVinyl,
};
