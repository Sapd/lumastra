// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for CostLedger — per-run accumulator, isolation, finalize cleanup.
 *
 * Run with: npx vitest run src/lib/server/tasks/cost-ledger.test.ts
 */

import { describe, it, expect } from 'vitest';
import { CostLedger } from './cost-ledger.js';
import type { CostKind } from '@sapd/lumastra-plugin-sdk';

describe('CostLedger', () => {
    it('accumulates spend calls for the same kind', () => {
        const ledger = new CostLedger();
        const spend = ledger.create('run_1');

        spend.spend('openai_tokens', 100);
        spend.spend('openai_tokens', 50);

        expect(spend.snapshot()).toEqual({ openai_tokens: 150 });
    });

    it('accumulates spend across different kinds independently', () => {
        const ledger = new CostLedger();
        const spend = ledger.create('run_2');

        spend.spend('openai_tokens', 200);
        spend.spend('cpu_seconds', 5);
        spend.spend('api_calls', 3);

        expect(spend.snapshot()).toEqual({
            openai_tokens: 200,
            cpu_seconds: 5,
            api_calls: 3,
        });
    });

    it('isolates spend state between different runs', () => {
        const ledger = new CostLedger();
        const spend1 = ledger.create('run_a');
        const spend2 = ledger.create('run_b');

        spend1.spend('openai_tokens', 999);
        spend2.spend('openai_tokens', 1);

        expect(spend1.snapshot()).toEqual({ openai_tokens: 999 });
        expect(spend2.snapshot()).toEqual({ openai_tokens: 1 });
    });

    it('finalize() returns the final breakdown and clears internal state', () => {
        const ledger = new CostLedger();
        const spend = ledger.create('run_fin');

        spend.spend('cpu_seconds', 10);
        spend.spend('api_calls', 2);

        const breakdown = ledger.finalize('run_fin');
        expect(breakdown).toEqual({ cpu_seconds: 10, api_calls: 2 });

        // Second finalize on the same run → empty (entry was removed).
        const second = ledger.finalize('run_fin');
        expect(second).toEqual({});
    });

    it('finalize() on a run that was never created returns {}', () => {
        const ledger = new CostLedger();
        expect(ledger.finalize('run_ghost')).toEqual({});
    });

    it('snapshot() on an empty accumulator returns {}', () => {
        const ledger = new CostLedger();
        const spend = ledger.create('run_empty');
        expect(spend.snapshot()).toEqual({});
    });

    it('silently drops spend calls for unknown kinds (TASK-H19 cardinality guard)', () => {
        const ledger = new CostLedger();
        const spend = ledger.create('run_guard');

        // Cast via unknown to simulate a plugin passing an invalid kind at runtime.
        spend.spend('openai_tokens', 10);
        spend.spend('openai_tokens' as unknown as CostKind, 10); // valid — counts
        spend.spend('unknown_kind' as unknown as CostKind, 999); // invalid — dropped

        const breakdown = ledger.finalize('run_guard');
        expect(breakdown).toEqual({ openai_tokens: 20 });
        expect('unknown_kind' in breakdown).toBe(false);
    });

    it('accepts the bounded api_calls:<host> namespace but rejects an over-long host', () => {
        const ledger = new CostLedger();
        const spend = ledger.create('run_apicalls_ns');

        spend.spend('api_calls', 5);
        spend.spend('api_calls:api.themoviedb.org', 3);
        spend.spend('api_calls:api.mdblist.com', 2);
        // Over the 253-char DNS host cap — dropped to avoid JSONB bloat.
        spend.spend(`api_calls:${'x'.repeat(300)}` as CostKind, 9);

        const breakdown = ledger.finalize('run_apicalls_ns');
        expect(breakdown).toEqual({
            api_calls: 5,
            'api_calls:api.themoviedb.org': 3,
            'api_calls:api.mdblist.com': 2,
        });
    });

    it('accepts the per-host api_errors:<host> and api_429:<host> namespaces, bounded like api_calls', () => {
        const ledger = new CostLedger();
        const spend = ledger.create('run_api_errors_ns');

        spend.spend('api_errors:musicbrainz.org', 2);
        spend.spend('api_429:musicbrainz.org', 1);
        // Same 253-char host cap as api_calls:<host>.
        spend.spend(`api_errors:${'x'.repeat(300)}` as CostKind, 9);
        // Unknown namespaces stay rejected.
        spend.spend('api_other:musicbrainz.org' as CostKind, 4);

        expect(ledger.finalize('run_api_errors_ns')).toEqual({
            'api_errors:musicbrainz.org': 2,
            'api_429:musicbrainz.org': 1,
        });
    });

    it('snapshot() does not mutate internal state', () => {
        const ledger = new CostLedger();
        const spend = ledger.create('run_snap');

        spend.spend('openai_tokens', 50);
        const s1 = spend.snapshot();
        spend.spend('openai_tokens', 50);
        const s2 = spend.snapshot();

        // s1 should reflect the state at the time it was called.
        expect(s1.openai_tokens).toBe(50);
        expect(s2.openai_tokens).toBe(100);
    });
});

it('refuses private and custom hosts in the new error namespaces at the ledger boundary', () => {
    const ledger = new CostLedger();
    const { spend } = ledger.create('private-errors');
    for (const host of ['10.0.0.1', 'jellyfin.internal', 'custom-ai.example', 'unknown']) {
        spend(`api_errors:${host}`, 1);
        spend(`api_429:${host}`, 1);
    }
    spend('api_errors:api.openai.com', 1);
    expect(ledger.finalize('private-errors')).toEqual({ 'api_errors:api.openai.com': 1 });
});
