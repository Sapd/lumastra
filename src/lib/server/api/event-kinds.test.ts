// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guard for `EVENT_KINDS` (docs/architecture/user-events.md, "The guard,
 * because a comment is not a mechanism").
 *
 * The taxonomy drifted before because nothing tied "advertised" to "the wire
 * actually sends this" — `ADVERTISED_EVENT_TYPES` named `maintenance.notice`,
 * `maintenance.cleared` and `session.changed`, none of which any emitter ever
 * wrote to an SSE frame. This test is the inverse of that honour-system
 * comment: it reads the real emitter source from disk and asserts each
 * `EVENT_KINDS[].name` appears there as the literal string handed to the
 * wire, not a paraphrase of it.
 *
 * No skip list. `EMITTER_CHECKS` must cover every name in `EVENT_KINDS` —
 * the "covers every kind" test below fails loudly the moment a kind is added
 * without a matching entry, which is the failure mode a skip list would hide.
 * `library.new_episode` and `request.available` have no emitter yet, so their
 * checks point at `user-notifier.service.ts`, which does not exist yet
 * either — that is a deliberate, currently-failing assertion (per the task
 * this test was written for), not a bug: it is the contract the parallel
 * change adding that file must satisfy, expressed as a test rather than a
 * comment someone could forget to update.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    EVENT_KINDS,
    NOTIFICATION_EVENT_KIND_NAMES,
    type EventKindDescriptor,
} from './event-kinds.js';

const root = resolve(__dirname, '../../../..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');

/**
 * The taxonomy from docs/architecture/user-events.md, "Client contract",
 * verified against the wire (docs' own correction table). Pinning the exact
 * list — not just the names — catches a class/durable typo, not only a
 * missing/extra kind.
 */
const EXPECTED_KINDS: EventKindDescriptor[] = [
    { name: 'device.command', class: 'signal', durable: false },
    { name: 'device.command_cancelled', class: 'signal', durable: false },
    { name: 'device.command_status', class: 'signal', durable: false },
    { name: 'device.state', class: 'signal', durable: false },
    { name: 'session_changed', class: 'signal', durable: false },
    { name: 'watch_state_set_changed', class: 'signal', durable: false },
    { name: 'admin', class: 'signal', durable: false },
    { name: 'library.new_episode', class: 'notification', durable: true },
    { name: 'request.available', class: 'notification', durable: true },
    { name: 'admin.broadcast', class: 'notification', durable: true },
    { name: 'jellyfin.readonly_token', class: 'notification', durable: true },
];

/**
 * One entry per `EVENT_KINDS[].name`: where the wire string is written, and
 * the pattern that must match it there. Precise per-emitter patterns (not a
 * loose substring like `.includes('admin')`) so the check can't pass on an
 * unrelated occurrence of the name.
 */
interface EmitterCheck {
    file: string;
    pattern: RegExp;
    /** Only set for a kind with no emitter yet — explains the expected failure. */
    note?: string;
}

const EMITTER_CHECKS: Record<string, EmitterCheck> = {
    // publishUserEvent's `kind` becomes the SSE `event:` field verbatim
    // (sse-replay-hub.ts encodes `event: ${frame.type}` from it).
    'device.command': {
        file: 'src/lib/server/services/device-commands.service.ts',
        pattern: /'device\.command'/,
    },
    'device.command_cancelled': {
        file: 'src/lib/server/services/device-commands.service.ts',
        pattern: /'device\.command_cancelled'/,
    },
    'device.command_status': {
        file: 'src/lib/server/services/device-commands.service.ts',
        pattern: /kind:\s*'device\.command_status'/,
    },
    'device.state': {
        file: 'src/lib/server/services/device-commands.service.ts',
        pattern: /kind:\s*'device\.state'/,
    },
    session_changed: {
        // The wire emission is `sendExtra(evt.type, evt)` in defs/events/index.ts
        // — the literal that decides the frame's `event:` field lives here,
        // at the point `evt.type` is assigned.
        file: 'src/lib/server/services/watch-state-events.service.ts',
        pattern: /type:\s*'session_changed'/,
    },
    watch_state_set_changed: {
        file: 'src/lib/server/services/watch-state-events.service.ts',
        pattern: /type:\s*'watch_state_set_changed'/,
    },
    admin: {
        // Every admin/maintenance frame is sent via sendExtra('admin', ...);
        // data.type distinguishes maintenance_notice/cleared/admin_message,
        // but the SSE `event:` field is always this literal.
        file: 'src/lib/server/api/defs/events/index.ts',
        pattern: /sendExtra\(\s*'admin'/,
    },
    'library.new_episode': {
        file: 'src/lib/server/services/user-notifier.service.ts',
        pattern: /'library\.new_episode'/,
        note:
            'user-notifier.service.ts is added by a parallel change ' +
            '(docs/architecture/user-events.md, "Emitters and hook points"). ' +
            'This assertion is the contract that change must satisfy, not a defect here.',
    },
    'request.available': {
        file: 'src/lib/server/services/user-notifier.service.ts',
        pattern: /'request\.available'/,
        note:
            'user-notifier.service.ts is added by a parallel change ' +
            '(docs/architecture/user-events.md, "Emitters and hook points"). ' +
            'This assertion is the contract that change must satisfy, not a defect here.',
    },
    'jellyfin.readonly_token': {
        file: 'src/lib/server/services/jellyfin-token-notice.service.ts',
        pattern: /kind:\s*'jellyfin\.readonly_token'/,
    },
    'admin.broadcast': {
        // The per-recipient fan-out in sendBroadcast() calls publishUserEvent
        // with this literal, same convention as user-notifier.service.ts's two:
        // the emitter re-declares the wire string rather than importing the
        // taxonomy constant, so this grep proves the string is EMITTED and not
        // merely advertised.
        file: 'src/lib/server/services/admin-broadcast.service.ts',
        pattern: /'admin\.broadcast'/,
    },
};

describe('EVENT_KINDS taxonomy', () => {
    it('matches docs/architecture/user-events.md exactly (name, class, durable)', () => {
        expect(EVENT_KINDS).toEqual(EXPECTED_KINDS);
    });

    it('NOTIFICATION_EVENT_KIND_NAMES is derived, not hand-copied', () => {
        const expected = EVENT_KINDS.filter((k) => k.class === 'notification').map((k) => k.name);
        expect(NOTIFICATION_EVENT_KIND_NAMES).toEqual(expected);
        expect(NOTIFICATION_EVENT_KIND_NAMES).toEqual([
            'library.new_episode',
            'request.available',
            'admin.broadcast',
            'jellyfin.readonly_token',
        ]);
    });
});

describe('EVENT_KINDS guard — every advertised kind has a real emitter (no skip list)', () => {
    it('EMITTER_CHECKS has an entry for every kind — nothing is silently exempt', () => {
        const covered = new Set(Object.keys(EMITTER_CHECKS));
        const missing = EVENT_KINDS.map((k) => k.name).filter((name) => !covered.has(name));
        expect(
            missing,
            `these kinds have no emitter check registered: ${missing.join(', ')}`,
        ).toEqual([]);
    });

    it('EMITTER_CHECKS has no stray entry for a kind that is not advertised', () => {
        const advertised = new Set(EVENT_KINDS.map((k) => k.name));
        const stray = Object.keys(EMITTER_CHECKS).filter((name) => !advertised.has(name));
        expect(stray, `checks exist for kinds not in EVENT_KINDS: ${stray.join(', ')}`).toEqual([]);
    });

    for (const kind of EVENT_KINDS) {
        const check = EMITTER_CHECKS[kind.name];

        it(`'${kind.name}' is emitted as a literal wire string in ${check?.file ?? '(unregistered)'}`, () => {
            if (!check) {
                // Caught by the "has an entry for every kind" test above; fail
                // here too so this test's own title stays truthful standalone.
                throw new Error(`no EmitterCheck registered for '${kind.name}'`);
            }

            const exists = existsSync(resolve(root, check.file));
            if (!exists) {
                throw new Error(
                    `${check.file} does not exist yet.` + (check.note ? ` ${check.note}` : ''),
                );
            }

            const src = read(check.file);
            expect(
                src,
                `expected the literal wire string for '${kind.name}' in ${check.file}` +
                    (check.note ? ` — ${check.note}` : ''),
            ).toMatch(check.pattern);
        });
    }
});

describe('global SSE payload documentation', () => {
    it('names a registered payload schema for every advertised event kind', async () => {
        const { SSE_FRAME_SCHEMAS } = await import('../../../../scripts/openapi/sse-frames');
        const source = read('src/lib/server/api/defs/events/index.ts');
        for (const kind of EVENT_KINDS) {
            const row = source.split('\n').find((line) => line.includes('| `' + kind.name + '` |'));
            expect(row, `missing frame row for ${kind.name}`).toBeDefined();
            const schemas = row!.match(/Sse\w+Frame/g) ?? [];
            expect(schemas.length, kind.name).toBeGreaterThan(0);
            for (const name of schemas) expect(SSE_FRAME_SCHEMAS).toHaveProperty(name);
        }
    });
});
