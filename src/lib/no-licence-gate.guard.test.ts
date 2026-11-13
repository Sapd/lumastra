// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guard: Lumastra has no licence gate. Nothing in `src/` may read a licence key,
 * ask an entitlement registry, or call a licence endpoint. A file may use the
 * `requireModuleOr*` / `moduleGateResponse` helpers only if it imports them from
 * a private `module-gate` module (an opt-in gate that is off by default).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ServerCapabilitiesSchema } from '$lib/schemas/server-info.js';

const SRC = join(process.cwd(), 'src');
const SELF = 'src/lib/no-licence-gate.guard.test.ts';

const FORBIDDEN =
    /getEffectiveEntitlements|isModuleLicensed|FREE_TIER_ENTITLEMENTS|LICENSE_KEY|LICENSE_ENFORCEMENT|jellyfinMaxConcurrentStreams|api\/license\//;
const GATE_HELPERS = /requireModuleOr404|requireModuleOrRedirect|moduleGateResponse/;

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === 'paraglide' || name === 'node_modules') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|js|svelte|json)$/.test(name) && !name.endsWith('base-schema-sql.ts')) {
            out.push(full);
        }
    }
    return out;
}

const files = walk(SRC)
    .map((full) => ({ path: relative(process.cwd(), full), text: readFileSync(full, 'utf8') }))
    .filter((f) => f.path !== SELF);

describe('no licence gate in src', () => {
    it('has no reference to the removed entitlement and key machinery', () => {
        const hits = files.filter((f) => FORBIDDEN.test(f.text)).map((f) => f.path);
        expect(hits).toEqual([]);
    });

    it('uses the module-gate helpers only through a module-gate import', () => {
        const hits = files
            .filter((f) => GATE_HELPERS.test(f.text) && !/\/module-gate(\.js)?'/.test(f.text))
            .filter((f) => !f.path.endsWith('/module-gate.ts'))
            .map((f) => f.path);
        expect(hits).toEqual([]);
    });
});

describe('capabilities contract', () => {
    it('keeps all four push unavailableReason values for shipped Apple clients', () => {
        const shape = ServerCapabilitiesSchema.shape.push.shape.unavailableReason;
        expect([...shape.unwrap().options].sort()).toEqual([
            'device_auth_disabled',
            'feature_disabled',
            'no_relay_credential',
            'not_entitled',
        ]);
    });
});
