// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Players that only fetch playlists and segments (VLC, Kodi) never send keepalives, so every
// media playlist and segment route must count as a heartbeat. A merge once dropped these calls
// from every route and segment-only viewers were reaped after the viewer timeout.
const MEDIA_ROUTES = [
    '[segment].ts',
    'a/[output]/[segment].ts',
    'a/[output]/playlist.m3u8.ts',
    'r/[rung]/[segment].ts',
    'r/[rung]/playlist.m3u8.ts',
    'v/[variant]/[file].ts',
    'v/[variant]/master.m3u8.ts',
    'v/[variant]/playlist.m3u8.ts',
];
// Master routes join the proxy; a hover preview must join at low priority.
const JOIN_ROUTES = ['master.m3u8.ts', 'a/master.m3u8.ts', 'r/[rung]/master.m3u8.ts'];

function source(route: string): string {
    return readFileSync(fileURLToPath(new URL(route, import.meta.url)), 'utf8');
}

describe('Live TV stream route wiring', () => {
    it.each(MEDIA_ROUTES)('%s refreshes the viewer on every fetch', (route) => {
        expect(source(route)).toMatch(/touchLiveTvViewer\(event, channelId\)/);
    });
    it.each(JOIN_ROUTES)('%s joins a preview at low priority', (route) => {
        expect(source(route)).toMatch(/liveTvJoinPriority\(/);
    });
});
