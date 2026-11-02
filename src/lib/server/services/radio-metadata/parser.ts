// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { CANONICAL_FIELD_IDS, type CanonicalFieldId } from '$lib/schemas/radio';
import type { FlatFields } from './types';
import { execRegexWithBudget } from './regex-runner';

const NUMERIC_FIELDS: ReadonlySet<CanonicalFieldId> = new Set([
    'trackDurationSeconds',
    'trackElapsedSeconds',
]);

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_FIELD_IDS);

/** Minimal JSONPath: $.a.b, $.a[0].b — no filters, no wildcards. */
function resolveJsonPath(root: unknown, path: string): unknown {
    if (!path.startsWith('$')) return undefined;
    const tokens = path
        .slice(1)
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .filter(Boolean);
    let cur: unknown = root;
    for (const tok of tokens) {
        if (cur === null || cur === undefined) return undefined;
        if (Array.isArray(cur) && /^\d+$/.test(tok)) {
            cur = cur[Number(tok)];
        } else if (typeof cur === 'object') {
            cur = (cur as Record<string, unknown>)[tok];
        } else {
            return undefined;
        }
    }
    return cur;
}

function coerce(fieldId: CanonicalFieldId, raw: unknown): string | number | undefined {
    if (raw === null || raw === undefined) return undefined;
    if (NUMERIC_FIELDS.has(fieldId)) {
        const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
        return Number.isFinite(n) && n >= 0 ? n : undefined;
    }
    const s = String(raw).trim();
    return s.length > 0 ? s : undefined;
}

export function parseJson(
    response: unknown,
    jsonPaths: Partial<Record<CanonicalFieldId, string>>,
): FlatFields {
    const out: FlatFields = {};
    for (const [rawKey, path] of Object.entries(jsonPaths)) {
        if (!path) continue;
        const fieldId = rawKey as CanonicalFieldId;
        if (!CANONICAL_SET.has(fieldId)) continue;
        const raw = resolveJsonPath(response, path);
        const val = coerce(fieldId, raw);
        if (val !== undefined) out[fieldId] = val;
    }
    return out;
}

/**
 * Hard caps on the text handed to the regex engine.
 *
 * Security review 2026-09-12, C7: the fetcher accepts up to 1 MiB, and regex
 * cost against a hostile body is at best linear and often quadratic in its
 * length. A "now playing" payload is a line or two; anything past these caps is
 * not metadata, so truncating costs nothing real and bounds the worst case.
 */
const MAX_REGEX_INPUT_CHARS = 64 * 1024;
const MAX_REGEX_INPUT_LINES = 200;

/** Truncate upstream text to the first 64 KiB and the first 200 lines. */
export function capRegexInput(text: string): string {
    const sliced =
        text.length > MAX_REGEX_INPUT_CHARS ? text.slice(0, MAX_REGEX_INPUT_CHARS) : text;
    let cut = -1;
    for (let seen = 0; seen < MAX_REGEX_INPUT_LINES; seen++) {
        const next = sliced.indexOf('\n', cut + 1);
        if (next === -1) return sliced;
        cut = next;
    }
    return sliced.slice(0, cut);
}

type QuantKind = 'none' | 'optional' | 'repeat';

/**
 * Read the quantifier (if any) that applies to the atom ending at `i`.
 * `repeat` means "can match the preceding atom more than once" — the only kind
 * that turns an ambiguous sub-pattern into exponential backtracking. `?` and
 * `{0,1}` are `optional`: they add no repetition of their own but still make an
 * enclosing group's body ambiguous.
 */
function readQuantifier(src: string, i: number): { kind: QuantKind; next: number } {
    const ch = src[i];
    if (ch === '*' || ch === '+') {
        let n = i + 1;
        if (src[n] === '?' || src[n] === '+') n++; // lazy / possessive suffix
        return { kind: 'repeat', next: n };
    }
    if (ch === '?') {
        let n = i + 1;
        if (src[n] === '?') n++;
        return { kind: 'optional', next: n };
    }
    if (ch === '{') {
        const close = src.indexOf('}', i);
        if (close === -1) return { kind: 'none', next: i };
        const parsed = /^(\d+)(,(\d*))?$/.exec(src.slice(i + 1, close));
        if (!parsed) return { kind: 'none', next: i }; // a literal '{'
        let n = close + 1;
        if (src[n] === '?') n++;
        const min = Number(parsed[1]);
        const max =
            parsed[2] === undefined
                ? min
                : parsed[3] === ''
                  ? Number.POSITIVE_INFINITY
                  : Number(parsed[3]);
        if (max > 1) return { kind: 'repeat', next: n };
        if (max === 1 && min === 0) return { kind: 'optional', next: n };
        return { kind: 'none', next: n };
    }
    return { kind: 'none', next: i };
}

/** Index of the first character of a group's body, skipping `?:`, `?<name>`, lookarounds. */
function groupBodyStart(src: string, open: number): number {
    if (src[open + 1] !== '?') return open + 1;
    const c2 = src[open + 2];
    if (c2 === ':' || c2 === '=' || c2 === '!') return open + 3;
    if (c2 === '<') {
        const c3 = src[open + 3];
        if (c3 === '=' || c3 === '!') return open + 4; // lookbehind
        const gt = src.indexOf('>', open + 3);
        return gt === -1 ? open + 3 : gt + 1; // named group
    }
    return open + 2;
}

/**
 * Whether a quantified group's alternation branches provably cannot both match
 * the same input, which is what makes `(a|b)+` linear and `(a|a)+` / `(a|aa)+`
 * exponential. Proving disjointness in general needs a real automaton, so this
 * only accepts the one shape it can decide for certain — distinct single
 * literal characters — and rejects everything else.
 */
function branchesProvablyDisjoint(branches: string[]): boolean {
    const seen = new Set<string>();
    for (const branch of branches) {
        if (branch.length !== 1) return false;
        if (/[\\^$.|?*+()[\]{}]/.test(branch)) return false;
        if (seen.has(branch)) return false;
        seen.add(branch);
    }
    return true;
}

interface GroupFrame {
    bodyStart: number;
    /** A quantifier appears somewhere inside this group (at any depth). */
    hasQuantifier: boolean;
    /** Offsets of the `|` separators at this group's own nesting level. */
    splits: number[];
}

/**
 * Static rejection of patterns that can backtrack catastrophically.
 *
 * Security review 2026-09-12, C7: the original heuristic was a single regex
 * (`/\([^()]*[+*][^()]*\)[+*]/`) that only saw a quantifier directly inside a
 * directly-quantified group. It missed `(a|a)+`, `((a|b)+)+`, `(a*){2,}` and
 * anything with a character class or a named group in the way. This walks the
 * pattern instead and rejects a repeat-quantified group that either contains a
 * quantifier of its own or offers an alternation whose branches may overlap.
 *
 * This is a configuration-time guard, not the only one: quadratic patterns with
 * no nested quantifier at all (`(?<artist>.+) - (?<title>.+)`) are legitimate
 * and stay allowed, which is why the match also runs under a hard time budget.
 *
 * @returns a short reason string when the pattern is unsafe, else `null`.
 */
export function findUnsafeRegexReason(source: string): string | null {
    const stack: GroupFrame[] = [{ bodyStart: 0, hasQuantifier: false, splits: [] }];
    let i = 0;

    const markQuantifier = (): void => {
        for (const frame of stack) frame.hasQuantifier = true;
    };

    while (i < source.length) {
        const ch = source[i];

        if (ch === '\\') {
            i += 2; // escaped atom
            const q = readQuantifier(source, i);
            i = q.next;
            if (q.kind !== 'none') markQuantifier();
            continue;
        }

        if (ch === '[') {
            i++;
            if (source[i] === '^') i++;
            if (source[i] === ']') i++; // a leading ']' is literal
            while (i < source.length && source[i] !== ']') {
                if (source[i] === '\\') i++;
                i++;
            }
            i++; // the closing ']'
            const q = readQuantifier(source, i);
            i = q.next;
            if (q.kind !== 'none') markQuantifier();
            continue;
        }

        if (ch === '(') {
            stack.push({ bodyStart: groupBodyStart(source, i), hasQuantifier: false, splits: [] });
            i = stack[stack.length - 1].bodyStart;
            continue;
        }

        if (ch === ')') {
            const frame = stack.pop();
            if (!frame) return 'unbalanced group';
            const close = i;
            i++;
            const q = readQuantifier(source, i);
            i = q.next;
            if (q.kind === 'repeat') {
                if (frame.hasQuantifier) return 'nested quantifier';
                if (frame.splits.length > 0) {
                    const bounds = [frame.bodyStart, ...frame.splits.map((s) => s + 1)];
                    const ends = [...frame.splits, close];
                    const branches = bounds.map((start, idx) => source.slice(start, ends[idx]));
                    if (!branchesProvablyDisjoint(branches)) {
                        return 'ambiguous alternation under a quantifier';
                    }
                }
            }
            if (q.kind !== 'none') markQuantifier();
            continue;
        }

        if (ch === '|') {
            stack[stack.length - 1].splits.push(i);
            i++;
            continue;
        }

        i++; // a literal character
        const q = readQuantifier(source, i);
        i = q.next;
        if (q.kind !== 'none') markQuantifier();
    }

    return null;
}

/** Heuristic rejection of catastrophic backtracking. See {@link findUnsafeRegexReason}. */
export function isUnsafeRegex(source: string): boolean {
    return findUnsafeRegexReason(source) !== null;
}

/**
 * Match `pattern` against upstream text and project the named groups onto
 * canonical fields.
 *
 * Security review 2026-09-12, C7: async because the match runs in a worker
 * thread under a time budget — see `regex-runner.ts`. Callers get a rejected
 * promise (`RegexBudgetExceededError`) instead of a frozen event loop.
 */
export async function parseRegex(text: string, pattern: string): Promise<FlatFields> {
    if (!pattern.trim()) {
        throw new Error('Regex pattern must not be empty');
    }
    const unsafeReason = findUnsafeRegexReason(pattern);
    if (unsafeReason) {
        throw new Error(`Unsafe regex pattern (${unsafeReason})`);
    }
    try {
        // Compile here (cheap, and cannot backtrack) so an invalid pattern is
        // reported as such rather than as a worker failure.
        new RegExp(pattern, 'u');
    } catch (err) {
        throw new Error(`Invalid regex: ${(err as Error).message}`, {
            cause: err,
        });
    }
    const groups = await execRegexWithBudget(pattern, 'u', capRegexInput(text));
    if (!groups) return {};
    const out: FlatFields = {};
    for (const [name, value] of Object.entries(groups)) {
        if (!CANONICAL_SET.has(name)) continue;
        const val = coerce(name as CanonicalFieldId, value);
        if (val !== undefined) out[name as CanonicalFieldId] = val;
    }
    return out;
}
