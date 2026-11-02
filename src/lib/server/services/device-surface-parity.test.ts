// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Structural guards for the device subsystem.
 *
 * Behavioural tests prove the read model is right. These prove nobody has
 * quietly stopped using it — which is the failure that actually happened: four
 * copy-pasted device-list merges drifted apart until the same device showed a
 * different name on every screen, and each of them read the Jellyfin credential
 * string first so it shadowed the real name.
 *
 * Modelled on the ERASURE_TABLE_REGISTRY completeness test, which is what
 * caught user_devices missing from GDPR erasure. Enumerating the surfaces and
 * asserting a property over all of them catches the copy that gets added later;
 * testing each surface individually does not.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');

/**
 * Every surface that renders a list of a user's devices.
 *
 * Add new device-list surfaces here. A surface missing from this list is not
 * covered by the parity guarantee, which is the whole point of listing them.
 */
const DEVICE_LIST_SURFACES = [
    'src/lib/server/api/defs/devices/index.ts',
    'src/lib/server/api/defs/admin/devices/index.ts',
    'src/routes/settings/sessions/+page.server.ts',
];

describe('device surface parity', () => {
    it('every listed surface exists (the list has not gone stale)', () => {
        for (const surface of DEVICE_LIST_SURFACES) {
            expect(existsSync(resolve(root, surface)), `${surface} is listed but missing`).toBe(
                true,
            );
        }
    });

    it('every device-list surface resolves names through the single read model', () => {
        // Require both the import and a call, and match them precisely — a
        // substring check would happily accept `getUserDevicesFromSomewhereElse`.
        const importsModel = /from\s+'\$lib\/server\/services\/user-devices\.service(\.js)?'/;
        const callsModel = /\bgetUserDevices\s*\(/;
        const offenders = DEVICE_LIST_SURFACES.filter((s) => {
            const src = read(s);
            return !importsModel.test(src) || !callsModel.test(src);
        });
        expect(
            offenders,
            `These surfaces do not use getUserDevices(), so their device names can drift from ` +
                `every other screen:\n  ${offenders.join('\n  ')}`,
        ).toEqual([]);
    });

    it('no device-list surface hand-rolls its own token merge', () => {
        // The drifted copies all looked like this: a Map keyed by
        // device_session_id, filled from the Jellyfin token table first.
        const offenders = DEVICE_LIST_SURFACES.filter((s) => {
            const src = read(s);
            return src.includes('sessionsMap') || src.includes('getActiveTokensForUser');
        });
        expect(
            offenders,
            `These surfaces rebuild the device list by hand instead of using the read ` +
                `model:\n  ${offenders.join('\n  ')}`,
        ).toEqual([]);
    });

    it('no device-list surface reads the Jellyfin credential as a display name', () => {
        // provider_device_binding is "${APP_NAME} - ${name}" and is a credential.
        // Reading it into a device list is the exact regression this subsystem had.
        const offenders = DEVICE_LIST_SURFACES.filter((s) =>
            read(s).includes('provider_device_binding'),
        );
        expect(
            offenders,
            `These surfaces reference the Jellyfin credential string:\n  ${offenders.join('\n  ')}`,
        ).toEqual([]);
    });

    it('the read model itself never reads a Jellyfin table', () => {
        // Jellyfin is optional. The device list must be identical whether it is
        // installed or not, so core must not consult the provider token table.
        const src = read('src/lib/server/services/user-devices.service.ts');
        const code = src
            .split('\n')
            .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
            .join('\n');
        expect(code).not.toContain('user_provider_device_tokens');
        expect(code).not.toContain('jellyfin-token.service');
    });
});

describe('Jellyfin device binding contract', () => {
    const tokenService = 'src/lib/server/oauth/jellyfin-token.service.ts';

    it('the stored binding is replayed verbatim, never recomputed from a display name', () => {
        // Jellyfin binds an access token to the exact (token, deviceId, deviceName)
        // triple presented at Quick Connect. If the replayed Device="..." string is
        // rebuilt from a name the user can change, every existing token 401s the
        // moment they rename their TV.
        const src = read(tokenService);

        // The value handed back for reuse must come from the stored column.
        expect(src).toContain('existing.provider_device_binding');

        // The "${APP_NAME} - ${name}" composition may happen only where a NEW
        // token is minted, never on the reuse path.
        const composeSites = src
            .split('\n')
            .map((line, i) => ({ line, i }))
            .filter(({ line }) => line.includes('${config.APP_NAME} - '));
        expect(
            composeSites.length,
            'The binding string should be composed exactly once, at Quick Connect time',
        ).toBe(1);
    });

    it('the auth header escapes client-controlled values', () => {
        // The MediaBrowser Authorization header is a quoted key="value" list with
        // no escape mechanism, so an unescaped quote in a device name would inject
        // extra pairs into the credentials we send upstream.
        const { Authorization } = buildJellyfinAuthHeaders({
            token: 'abc123',
            deviceName: 'evil", Token="stolen", DeviceId="x',
            deviceId: 'dev"ice',
        });
        const keys = [...Authorization.matchAll(/(\w+)="/g)].map((match) => match[1]);
        expect(keys).toEqual(['Client', 'Device', 'DeviceId', 'Version', 'Token']);
        expect(Authorization).toContain('Token="abc123"');
        expect(Authorization).not.toContain('stolen"');
        expect(() =>
            buildJellyfinAuthHeaders({ token: 'abc", Client="x', deviceName: 'd' }),
        ).toThrow('Invalid Jellyfin token');
    });
});

describe('migration registration', () => {
    // This guard used to name one migration: `16.176.0_user_devices_entity`,
    // because that exact registration was once dropped by a concurrent change
    // while the migration file was still untracked — the migration silently
    // stopped running and every downstream failure was baffling.
    //
    // The 2026-08-25 squash folded 16.126.0–16.228.0 into the base schema and
    // DELETED their files, so pinning that one name made this test fail on a
    // migration that no longer exists — while quietly no longer guarding
    // anything for the migrations that come next.
    //
    // Generalized to the invariant the original was reaching for: creating the
    // file is not enough, it must also be registered (CLAUDE.md — migrations
    // are a 2-step process). It holds trivially today (no incremental
    // migrations exist post-squash) and re-arms by itself the moment one lands.
    it('every migration file on disk is imported AND listed in MIGRATIONS', () => {
        const dir = resolve(root, 'src/lib/server/database/migrations');
        if (!existsSync(dir)) return; // squashed away; nothing to register yet

        // `.test.ts` / `.integration.test.ts` sidecars live in this directory too
        // and match the version-prefixed name pattern, but they are tests OF a
        // migration — they are never imported by migrate-schema.ts and must not
        // be, so including them here asserted the opposite of the invariant and
        // made this test red for a correctly-registered migration.
        const files = readdirSync(dir).filter(
            (f) => /^\d+\.\d+\.\d+_.+\.ts$/.test(f) && !/\.test\.ts$/.test(f),
        );
        const schema = read('src/lib/server/database/migrate-schema.ts');

        for (const file of files) {
            const base = file.replace(/\.ts$/, '');
            const symbol = `migration_${base.split('_')[0].replace(/\./g, '_')}`;

            expect(
                schema.includes(base),
                `${file} exists but migrate-schema.ts does not import it — it will never run`,
            ).toBe(true);
            expect(
                new RegExp(`^\\s*${symbol},\\s*$`, 'm').test(schema),
                `${file} is imported but not listed in the MIGRATIONS array — it will never run`,
            ).toBe(true);
        }
    });
});
