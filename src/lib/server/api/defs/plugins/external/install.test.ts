// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ResponseDef } from '$lib/server/openapi';

// Audit-actor coverage (fix round 1, R5 follow-through) — the admin twin
// (`defs/admin/plugins/external/install.ts`) already has a handler test;
// this v1 def did not. Mocked BEFORE `import { def } from './install.js'`
// below (vi.mock is hoisted regardless of source position).
const mockInstallExternalPlugin = vi.fn();
vi.mock('$lib/server/plugins/external-install/installer.js', () => ({
    installExternalPlugin: (...args: unknown[]) => mockInstallExternalPlugin(...args),
}));

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockGetDb(),
}));

import { def } from './install.js';

/** Narrow a `ResponseDef` to its `{schema}` variant, failing loudly otherwise. */
function schemaOf(d: ResponseDef) {
    if (typeof d === 'string' || !('schema' in d)) {
        throw new Error('Expected a { schema } response definition');
    }
    return d.schema;
}

describe('POST /plugins/external/install def', () => {
    it('body schema accepts force + rejects a non-url manifestUrl', () => {
        const body = def.docs!.POST!.body!;
        expect(
            body.safeParse({ manifestUrl: 'https://h/m.json', signature: 's', force: true })
                .success,
        ).toBe(true);
        expect(body.safeParse({ manifestUrl: 'not a url', signature: 's' }).success).toBe(false);
    });
    it('declares 409 + 422 responses', () => {
        expect(def.docs!.POST!.responses[409]).toBeDefined();
        expect(def.docs!.POST!.responses[422]).toBeDefined();
    });
    it('install descriptor accepts signingKeyId + signingKeySource', () => {
        const schema = schemaOf(def.docs!.POST!.responses[201]);
        expect(
            schema.safeParse({ id: 'p', signingKeyId: 'ops', signingKeySource: 'official' })
                .success,
        ).toBe(true);
    });
});

describe('POST /plugins/external/install def — audit actor', () => {
    function makeEvent(locals: Record<string, unknown>): RequestEvent {
        return {
            request: {
                json: async () => ({ manifestUrl: 'https://h/m.json', signature: 's' }),
            },
            locals,
        } as unknown as RequestEvent;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({} as never);
        mockInstallExternalPlugin.mockResolvedValue({ status: 201, body: {} });
    });

    it('passes the full Principal-derived actor, not a flattened username', async () => {
        const event = makeEvent({
            principal: { username: 'alice', kind: 'pat', credentialId: 'pat-1', isAdmin: true },
        });

        await def.handlers.POST!(event, {} as never);

        expect(mockInstallExternalPlugin).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            { username: 'alice', kind: 'pat', credentialId: 'pat-1' },
        );
    });

    it('falls back to a null-username actor when no identity resolved', async () => {
        const event = makeEvent({});

        await def.handlers.POST!(event, {} as never);

        expect(mockInstallExternalPlugin).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            { username: null },
        );
    });
});
