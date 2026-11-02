// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Canonical duration-string parser for the task system. SINGLE SOURCE OF TRUTH
 * for every human-written duration: `schedule.every` + its env override,
 * `timeout.hard`/`timeout.soft`, and `exclusiveWith.ttl`.
 *
 * Replaces three divergent hand-rolled copies that drifted apart on unit
 * support and compound handling:
 *   - `scheduler.parseDurationMs`     had `w`, lacked `ms`
 *   - `orchestrator.parseDurationToMs` had `ms`, lacked `w`
 *   - `runner.parseTaskDuration`       single-token only (no compound, no `w`)
 * so e.g. a `2w` timeout silently fell back to a default in the orchestrator,
 * a `500ms` schedule was rejected, and a `1h30m` timeout was rejected by the
 * runner. This is the UNION grammar — a strict superset, so every string the
 * old copies accepted parses to the same value; only previously-REJECTED
 * strings now parse.
 *
 * Grammar: one or more `<int><unit>` tokens, optionally whitespace-separated,
 * each unit appearing at most once. Units: `ms`, `s`, `m`, `h`, `d`, `w`.
 * Compound supported (`'1h30m'`, `'1w2d3h'`). Returns `null` (caller falls back
 * to a default — never throws) when the input is:
 *   - empty / whitespace-only / not a string
 *   - any char outside digits, allowed unit letters, or whitespace
 *     (rejects `'3.5h'`, `'-1h'`, `'3hour'`)
 *   - leftover text the tokenizer skipped (`'3h abc'`, `'1mh'`)
 *   - an unknown unit, or the same unit twice (`'1h1h'`)
 *   - a non-positive total (`'0m'`, `'0h0m'`)
 */

const DURATION_UNIT_MS: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 7 * 86_400_000,
};

export function parseDurationMs(input: string | undefined | null): number | null {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    // Reject anything other than digits, allowed unit letters, and whitespace
    // before tokenising — catches '3.5h', '3hour', '-1h'.
    if (!/^[\dsmhdw\s]+$/.test(trimmed)) return null;
    // `ms` MUST come before the single-letter `m` in the alternation so
    // '500ms' tokenises as 500·ms, not 500·m then a stray 's'.
    const tokens = trimmed.match(/(\d+)\s*(ms|[smhdw])/g);
    if (!tokens) return null;
    // Reject leftover text the token regex skipped (e.g. '3h abc 5m', '1mh').
    const consumed = tokens.join('').replace(/\s+/g, '');
    const stripped = trimmed.replace(/\s+/g, '');
    if (consumed !== stripped) return null;

    let total = 0;
    const seen = new Set<string>();
    for (const tok of tokens) {
        const m = /^(\d+)\s*(ms|[smhdw])$/.exec(tok);
        if (!m) return null;
        const unit = m[2];
        if (seen.has(unit)) return null; // duplicate unit ('1h1h')
        seen.add(unit);
        const n = Number(m[1]);
        if (!Number.isFinite(n) || n < 0) return null;
        total += n * DURATION_UNIT_MS[unit];
    }
    return total > 0 ? total : null;
}
