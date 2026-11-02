// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The red budget (design §6.3).
 *
 * Red is a claim on the operator's attention, and its value decays with every
 * producer that spends it. Nothing structural stops a new adapter adding
 * `severity: 'critical'` — the type permits it and review is the only gate,
 * which is exactly the pressure that turns a dashboard into decoration.
 *
 * So the count is committed here, using the same technique as
 * `UNDECLARED_BY_DESIGN_STAGE_IDS`: raising it is a visible diff in a file
 * whose only purpose is to make that number hard to raise.
 *
 * The scan reads the source rather than invoking the adapters, because the
 * question is "what CAN emit critical", not "what does today" — the latter
 * would need every adapter's worst-case input constructed, and would silently
 * stop covering an adapter the day its worst case changed.
 *
 * It deliberately catches BOTH forms. Two of the six reach critical only
 * through a ternary (`r.severity === 'error' ? 'critical' : 'warning'`), so a
 * scan for the literal property alone reports four and reads as a much
 * tighter budget than actually exists.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('./adapters.ts', import.meta.url));

/**
 * Every adapter permitted to make the dashboard red, and why it earns it.
 *
 * Adding an entry is a deliberate act. Before you do: `remediation: none` is
 * capped at info and `manual` at warning (§6.4), so if an operator cannot act
 * on it immediately it is not critical — it is a warning that needs better
 * copy.
 */
const RED_BUDGET: Record<string, string> = {
    // Work has stopped for a whole task and will not resume without a decision.
    adaptCircuits: 'a task is quarantined; nothing it owns is progressing',
    // Items have exhausted retries — data is missing and stays missing.
    adaptDeadLetter: 'items gave up permanently; only an operator restores them',
    // The server is about to stop being able to write anything at all.
    adaptStorageCapacity: 'a volume is nearly full; writes stop next',
    // Replicas disagree on the master key — secrets decrypt on one node, not another.
    adaptClusterKeyMismatch: 'replicas hold different master keys; behaviour is inconsistent',
    // A core worker heartbeat is dead: the task engine is not running.
    adaptTaskLiveness: 'a core worker is dead; background processing is stopped',
    // A named critical component is down (DB, cache, …).
    adaptComponentHealth: 'a component the server depends on is unavailable',
    // A published Lumastra release fixes a vulnerability this build still has.
    // Remediation is immediate and in the operator's hands: update.
    adaptLumastraUpdate: 'a security fix is released and this install is still exposed',
    // The pinned Live TV proxy is below the protocol this server needs: every live channel
    // fails. Remediation is immediate: update the proxy image to the named version.
    adaptLiveTvProxyCompat: 'the Live TV proxy is too old for this server; Live TV is down',
    // A container has sat at >= 95 % of its memory limit, or a machine under 5 % (and
    // 2 GiB) available, for 10 minutes: the OOM killer is next (prod's media node once
    // took a memcg-OOM kernel panic). Remediation is immediate: raise the limit or shed load.
    adaptResourcePressure: 'a container or machine is about to run out of memory',
};

/** Adapters found to be capable of emitting `critical`, by static scan. */
function adaptersThatCanEmitCritical(): string[] {
    const src = readFileSync(SOURCE, 'utf8');
    const starts = [...src.matchAll(/export function (adapt\w+)/g)].map((m) => ({
        at: m.index,
        name: m[1],
    }));

    const found: string[] = [];
    for (let i = 0; i < starts.length; i++) {
        const body = src.slice(starts[i].at, starts[i + 1]?.at ?? src.length);
        // Covers `severity: 'critical'` AND `severity: cond ? 'critical' : …`,
        // by asking whether 'critical' appears anywhere a severity is decided.
        const severityExprs = [...body.matchAll(/severity:\s*([^,\n]+)/g)].map((m) => m[1]);
        if (severityExprs.some((e) => e.includes("'critical'"))) found.push(starts[i].name);
    }
    return found.sort();
}

describe('attention red budget', () => {
    it('the scan finds adapters at all — a zero result would pass everything', () => {
        // Guards the whole file against becoming a no-op if the `export function
        // adapt*` convention ever changes.
        const src = readFileSync(SOURCE, 'utf8');
        expect([...src.matchAll(/export function (adapt\w+)/g)].length).toBeGreaterThan(10);
    });

    it('only budgeted adapters can make the dashboard red', () => {
        const actual = adaptersThatCanEmitCritical();
        const budgeted = Object.keys(RED_BUDGET).sort();
        // A failure here naming a NEW adapter means: justify the red, then add
        // it to RED_BUDGET with its reason. Do not delete this test.
        expect(actual).toEqual(budgeted);
    });

    it('every budgeted adapter states why it earns red', () => {
        for (const [name, reason] of Object.entries(RED_BUDGET)) {
            expect(reason.length, `${name} needs a justification`).toBeGreaterThan(20);
        }
    });

    it('holds the budget to single digits', () => {
        // Not arbitrary: past ~10 concurrent reds an operator triages instead of
        // acting, which is the failure mode §10.1 describes.
        expect(Object.keys(RED_BUDGET).length).toBeLessThan(10);
    });

    it('catches a ternary path, not just a literal one', () => {
        // Regression guard on the scan itself. adaptTaskLiveness has no
        // `severity: 'critical'` property anywhere — it reaches red through a
        // conditional — so its presence proves the scan is not literal-only.
        expect(adaptersThatCanEmitCritical()).toContain('adaptTaskLiveness');
        const src = readFileSync(SOURCE, 'utf8');
        const body = src.slice(src.indexOf('export function adaptTaskLiveness'));
        expect(body.slice(0, 3000)).not.toMatch(/severity:\s*'critical'/);
    });
});
