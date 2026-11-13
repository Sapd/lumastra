// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device identity for the `/j` compat surface.
 *
 * Lives in the proprietary tree on purpose: it exercises jellyfin-compat code, and
 * a core AGPL test may not import from here (proprietary may import core, never the
 * reverse — see user-devices.service.ts).
 *
 * The invariant these protect is subtle and was broken once: the stream-policy
 * ghost exclusion matches `NOT (device_id = X AND media_id = Y)`, so the manifest
 * route and the session writer must derive `device_id` identically. When they
 * drifted, a user on a one-stream limit was counted against their own stream and
 * got a 429 on it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    jellyfinCompatDeviceId,
    clampJellyfinDeviceId,
    MAX_JELLYFIN_DEVICE_ID_LENGTH,
} from './playback-utils.js';

const root = resolve(__dirname, '../../../../..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');

describe('jellyfinCompatDeviceId', () => {
    it('uses the client’s real DeviceId, so each Jellyfin app is its own device', () => {
        expect(jellyfinCompatDeviceId('infuse-abc123', 'user-1')).toBe('infuse-abc123');
        expect(jellyfinCompatDeviceId('streamyfin-xyz', 'user-1')).toBe('streamyfin-xyz');
    });

    it('gives two clients under one user two distinct device ids', () => {
        const a = jellyfinCompatDeviceId('infuse-abc123', 'user-1');
        const b = jellyfinCompatDeviceId('streamyfin-xyz', 'user-1');
        expect(a).not.toBe(b);
    });

    it('falls back to one synthetic id per user when the client sends none', () => {
        // Covers PAT-auth requests (no session to read a device from) and sessions
        // minted before device identity was threaded through, which carry ''.
        expect(jellyfinCompatDeviceId(null, 'user-1')).toBe('jellyfin-compat-user-1');
        expect(jellyfinCompatDeviceId(undefined, 'user-1')).toBe('jellyfin-compat-user-1');
        expect(jellyfinCompatDeviceId('', 'user-1')).toBe('jellyfin-compat-user-1');
        expect(jellyfinCompatDeviceId('   ', 'user-1')).toBe('jellyfin-compat-user-1');
    });

    it('never returns an empty id — play_sessions.device_id is NOT NULL', () => {
        for (const raw of [null, undefined, '', '  ', '\t']) {
            expect(jellyfinCompatDeviceId(raw, 'user-1')).not.toBe('');
        }
    });

    it('does not namespace the client id — /j/Sessions serialises it back to clients', () => {
        // Clients match the returned DeviceId against their own. A prefix here
        // would silently break that self-matching.
        expect(jellyfinCompatDeviceId('infuse-abc123', 'user-1')).not.toMatch(/^jellyfin-compat-/);
    });

    it('a client cannot claim the reserved fallback id', () => {
        // The ghost exclusion matches on device_id. A client reporting
        // `jellyfin-compat-<its own userId>` would share an exclusion key with its
        // other streams and could run two at once inside a one-stream limit.
        const spoofed = jellyfinCompatDeviceId('jellyfin-compat-user-1', 'user-1');
        expect(spoofed).not.toBe('jellyfin-compat-user-1');
        expect(spoofed).toBe('client:jellyfin-compat-user-1');
    });

    it('the impostor id is stable, so such a client still keeps one identity', () => {
        const a = jellyfinCompatDeviceId('jellyfin-compat-user-1', 'user-1');
        const b = jellyfinCompatDeviceId('jellyfin-compat-user-1', 'user-1');
        expect(a).toBe(b);
    });
});

describe('clampJellyfinDeviceId', () => {
    it('bounds a client-supplied id that becomes a permanent indexed key', () => {
        // DeviceId is exempt from the display-name sanitiser (it must round-trip
        // byte-for-byte), which also exempts it from that sanitiser's length cap.
        const huge = 'x'.repeat(10_000);
        expect(clampJellyfinDeviceId(huge).length).toBe(MAX_JELLYFIN_DEVICE_ID_LENGTH);
    });

    it('two over-long ids sharing a long prefix do not collapse into one device', () => {
        // A bare truncation would merge them silently; the digest keeps them apart.
        const shared = 'y'.repeat(MAX_JELLYFIN_DEVICE_ID_LENGTH + 50);
        const a = clampJellyfinDeviceId(shared + 'AAA');
        const b = clampJellyfinDeviceId(shared + 'BBB');
        expect(a).not.toBe(b);
        expect(a.length).toBe(MAX_JELLYFIN_DEVICE_ID_LENGTH);
        expect(b.length).toBe(MAX_JELLYFIN_DEVICE_ID_LENGTH);
    });

    it('leaves realistic ids untouched', () => {
        const real = 'a1b2c3d4e5f6a7b8c9d0e1f2';
        expect(clampJellyfinDeviceId(real)).toBe(real);
    });

    it('maps a missing id to empty, which the resolver turns into the fallback', () => {
        expect(clampJellyfinDeviceId(null)).toBe('');
        expect(jellyfinCompatDeviceId(clampJellyfinDeviceId(null), 'user-1')).toBe(
            'jellyfin-compat-user-1',
        );
    });
});

describe('device_id derivation is not duplicated', () => {
    const WRITER = 'src/lib/server/proprietary/jellyfin-compat/playback-utils.ts';
    const MANIFEST = 'src/routes/(proprietary)/j/Videos/[itemId]/master.m3u8/+server.ts';

    it('the manifest route derives policyDeviceId from the shared helper', () => {
        // If this route computes the id inline again, it can diverge from the
        // stored value and the ghost exclusion misses → self-429.
        //
        // Match the ASSIGNMENT, not a bare substring: the surrounding comment also
        // names the helper, so `toContain('jellyfinCompatDeviceId(')` stayed green
        // through a real revert.
        const src = read(MANIFEST);
        expect(src).toMatch(/policyDeviceId:[\s\S]{0,200}?jellyfinCompatDeviceId\(/);
    });

    it('neither site rebuilds the synthetic id inline', () => {
        const offenders = [WRITER, MANIFEST].filter((p) => {
            const src = read(p);
            // The literal may appear inside the helper and in comments; a
            // template-literal construction outside it is the smell.
            // Both syntaxes: a template literal and a string concatenation.
            const inlineBuilds = [
                ...(src.match(/`jellyfin-compat-\$\{/g) ?? []),
                ...(src.match(/['"]jellyfin-compat-['"]\s*\+/g) ?? []),
            ];
            // playback-utils legitimately contains exactly one — inside the helper.
            return p === WRITER ? inlineBuilds.length > 1 : inlineBuilds.length > 0;
        });
        expect(
            offenders,
            `These sites build the /j device id inline instead of calling ` +
                `jellyfinCompatDeviceId():\n  ${offenders.join('\n  ')}`,
        ).toEqual([]);
    });

    it('the session writer attributes sessions via the helper', () => {
        const src = read(WRITER);
        expect(src).toMatch(/device_id:\s*jellyfinCompatDeviceId\(/);
    });
});
