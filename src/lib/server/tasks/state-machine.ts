// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { luaLoader } from './lua/loader.js';
import { captureValkeyAuthority } from './lua/fenced.js';
import type { AuthorityToken } from '../../../task-runtime/authority/store.js';
import {
    LUMASTRA_RUN_STATE_TTL_ACTIVE_MS,
    LUMASTRA_RUN_STATE_TTL_TERMINAL_MS,
} from '$lib/server/config.js';
import { type ValkeyLike, requireClient } from './valkey-types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RunState = 'pending' | 'active' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export type StageState = 'waiting' | 'active' | 'completed' | 'failed' | 'skipped';

export interface TransitionRunOpts {
    runId: string;
    from: RunState;
    to: RunState;
    extra?: Record<string, string | number>;
}

export interface TransitionStageOpts {
    runId: string;
    stageId: string;
    from: StageState;
    to: StageState;
    extra?: Record<string, string | number>;
}

export interface IncrementStageOpts {
    runId: string;
    stageId: string;
    increment?: number;
    total?: number;
}

export interface ClaimRunOpts {
    runId: string;
    expectedState: RunState;
    instanceId: string;
    bootId: string;
    nowMs?: number;
}

export interface TransitionResult {
    ok: boolean;
    error?: string;
    fromState?: RunState | StageState;
    toState?: RunState | StageState;
}

export interface IncrementStageResult {
    ok: boolean;
    processed: number;
    autoCompleted: boolean;
    error?: string;
}

export interface ClaimResult {
    ok: boolean;
    error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function flattenExtra(extra: Record<string, string | number> | undefined): string[] {
    if (!extra) return [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(extra)) {
        out.push(k, String(v));
    }
    return out;
}

// ── State machine ─────────────────────────────────────────────────────────────

export class StateMachine {
    private readonly authority: Readonly<AuthorityToken> | undefined;

    constructor(
        private readonly getClient: () => ValkeyLike,
        authority?: AuthorityToken,
    ) {
        this.authority = captureValkeyAuthority(authority);
    }

    async transitionRun(opts: TransitionRunOpts): Promise<TransitionResult> {
        const client = this.getClient();
        const raw = await luaLoader.invoke(
            'transition-run',
            [`task:run:active:${opts.runId}`, `task:run:terminal:${opts.runId}`],
            [
                opts.from,
                opts.to,
                String(LUMASTRA_RUN_STATE_TTL_ACTIVE_MS),
                String(LUMASTRA_RUN_STATE_TTL_TERMINAL_MS),
                ...flattenExtra(opts.extra),
            ],
            client,
            this.authority,
        );
        return this.parseTransitionResult(raw, opts.from, opts.to);
    }

    async transitionStage(opts: TransitionStageOpts): Promise<TransitionResult> {
        const client = this.getClient();
        const raw = await luaLoader.invoke(
            'transition-stage',
            [`task:run:active:${opts.runId}`],
            [
                opts.stageId,
                opts.from,
                opts.to,
                String(LUMASTRA_RUN_STATE_TTL_ACTIVE_MS),
                ...flattenExtra(opts.extra),
            ],
            client,
            this.authority,
        );
        return this.parseTransitionResult(raw, opts.from, opts.to);
    }

    async incrementStage(opts: IncrementStageOpts): Promise<IncrementStageResult> {
        const client = this.getClient();
        const increment = opts.increment ?? 1;
        const total = opts.total ?? 0;
        const raw = await luaLoader.invoke(
            'increment-stage',
            [`task:run:active:${opts.runId}`],
            [
                opts.stageId,
                String(increment),
                String(total),
                String(LUMASTRA_RUN_STATE_TTL_ACTIVE_MS),
            ],
            client,
            this.authority,
        );
        return this.parseIncrementResult(raw);
    }

    async claimRun(opts: ClaimRunOpts): Promise<ClaimResult> {
        const client = this.getClient();
        const nowMs = opts.nowMs ?? Date.now();
        const raw = await luaLoader.invoke(
            'claim-run',
            [`task:run:active:${opts.runId}`],
            [opts.expectedState, opts.instanceId, opts.bootId, String(nowMs)],
            client,
            this.authority,
        );
        return this.parseClaimResult(raw);
    }

    /**
     * Re-seed the active hash for a retry attempt — but only when the prior
     * attempt actually terminated for a *retriable* reason. A cancelled run
     * must never be resurrected, and a cancel in flight must win.
     *
     * Redelivered attempts may pass their current queue lock/token to reset a
     * stranded active claim, after the runner excludes live continuations.
     *
     * Atomic via `reseed-for-retry.lua`. The probe-then-write that used to live
     * here had two holes (audit C1 + H2):
     *   - It only inspected the active hash. A cancelled run's active hash is
     *     DEL'd by transition-run.lua (fields move to the terminal hash), so
     *     the probe saw "missing" and re-seeded 'pending' — re-executing
     *     cancelled work. The Lua script now checks the terminal hash for
     *     `state='cancelled'` and skips.
     *   - The HGET/HSET gap let a concurrent cancel (active→'cancelling') be
     *     clobbered. Read + conditional write now run in one script.
     *
     * Returns:
     *   - `'reseeded'` when the hash was missing or in a non-cancelled terminal
     *      state (failed/completed) and is now `pending`.
     *   - `'skipped'` when a cancel won — the active hash is `cancelling` OR the
     *      terminal hash records `cancelled`. Caller must abort the retry.
     *   - `'kept-active'` when the hash is already `pending`/`active` (rare;
     *      caller can proceed with claim).
     */
    async reseedForRetry(
        runId: string,
        redelivery?: { lockKey: string; token: string },
    ): Promise<'reseeded' | 'skipped' | 'kept-active'> {
        const client = this.getClient();
        const raw = await luaLoader.invoke(
            'reseed-for-retry',
            [
                `task:run:active:${runId}`,
                `task:run:terminal:${runId}`,
                ...(redelivery ? [redelivery.lockKey] : []),
            ],
            [
                String(LUMASTRA_RUN_STATE_TTL_ACTIVE_MS),
                String(Date.now()),
                ...(redelivery ? [redelivery.token] : []),
            ],
            client,
            this.authority,
        );
        return this.parseReseedResult(raw);
    }

    private parseReseedResult(raw: unknown): 'reseeded' | 'skipped' | 'kept-active' {
        // Positional ['ok', value] success shape (see reseed-for-retry.lua).
        if (isPositionalOk(raw)) {
            const value = String(raw[1]);
            if (value === 'reseeded' || value === 'skipped' || value === 'kept-active') {
                return value;
            }
        }
        throw new Error(`reseedForRetry: unexpected Lua return: ${String(raw)}`);
    }

    // ── Result parsers ────────────────────────────────────────────────────────

    private parseTransitionResult(
        raw: unknown,
        from: RunState | StageState,
        to: RunState | StageState,
    ): TransitionResult {
        // v2 Lua scripts return positional ['err', msg] on failure.
        // The 'err' check MUST run before the generic array-length success
        // check below, because both shapes are 2-element arrays.
        if (isPositionalErr(raw)) {
            return { ok: false, error: String(raw[1]) };
        }
        // Legacy {err: '...'} shape — kept for fake mock clients in
        // state-machine.test.ts that bypass valkey-glide entirely.
        if (isLuaError(raw)) {
            return { ok: false, error: String(raw.err) };
        }
        // Success shape: positional [fromState, toState] (already positional
        // before v2; left unchanged in the Lua scripts).
        if (Array.isArray(raw) && raw.length >= 2) {
            return { ok: true, fromState: from, toState: to };
        }
        return { ok: false, error: `Unexpected Lua return: ${String(raw)}` };
    }

    private parseIncrementResult(raw: unknown): IncrementStageResult {
        // v2 increment-stage.lua returns positional ['err', msg] on failure.
        // The 'err' check MUST run before the generic array-length success
        // check below, because both shapes are 2-element arrays.
        if (isPositionalErr(raw)) {
            return {
                ok: false,
                processed: 0,
                autoCompleted: false,
                error: String(raw[1]),
            };
        }
        // Legacy {err: '...'} shape — kept for fake mock clients in
        // state-machine.test.ts that bypass valkey-glide entirely.
        if (isLuaError(raw)) {
            return {
                ok: false,
                processed: 0,
                autoCompleted: false,
                error: String(raw.err),
            };
        }
        if (Array.isArray(raw) && raw.length >= 2) {
            return {
                ok: true,
                processed: Number(raw[0]),
                autoCompleted: Number(raw[1]) === 1,
            };
        }
        return {
            ok: false,
            processed: 0,
            autoCompleted: false,
            error: `Unexpected Lua return: ${String(raw)}`,
        };
    }

    private parseClaimResult(raw: unknown): ClaimResult {
        // v2 claim-run.lua returns positional ['err', msg] / ['ok', 'claimed'].
        // The 'err' check MUST run first — both shapes are 2-element arrays
        // and ['err', ...] would otherwise be misread as a claim token.
        if (isPositionalErr(raw)) {
            return { ok: false, error: String(raw[1]) };
        }
        if (isPositionalOk(raw)) {
            return { ok: true };
        }
        // Legacy {err: '...'} / {ok: '...'} object shapes — retained so the
        // mock-based unit tests in state-machine.test.ts (which return raw
        // JS objects rather than going through valkey-glide) keep passing.
        if (isLuaError(raw)) {
            return { ok: false, error: String(raw.err) };
        }
        if (isLuaOk(raw)) {
            return { ok: true };
        }
        // Fallback: some Valkey/RESP3 paths surface the bare string or a
        // single-element array. Keep these for defence in depth.
        if (Array.isArray(raw) && raw.length > 0 && isClaimedToken(raw[0])) {
            return { ok: true };
        }
        if (isClaimedToken(raw)) {
            return { ok: true };
        }
        return { ok: false, error: `Unexpected Lua return: ${String(raw)}` };
    }
}

// ── Type guards ───────────────────────────────────────────────────────────────

function isLuaError(raw: unknown): raw is { err: unknown } {
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'err' in raw;
}

function isLuaOk(raw: unknown): raw is { ok: unknown } {
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'ok' in raw;
}

/**
 * v2 Lua failure shape: positional `['err', '<message>']`.
 * Returned by every v2 script when control flow takes an error branch.
 * Replaces the legacy `{err='...'}` table, which valkey-glide treated as
 * a RESP error reply and *threw* on the caller side.
 */
function isPositionalErr(raw: unknown): raw is [string, unknown] {
    return Array.isArray(raw) && raw.length === 2 && raw[0] === 'err';
}

/**
 * v2 Lua success shape for status-only returns: positional `['ok', '<value>']`.
 * Used by claim-run.lua (`['ok', 'claimed']`). transition-run / transition-stage
 * keep their `[fromState, toState]` success shape and rely on `isPositionalErr`
 * running first to disambiguate.
 */
function isPositionalOk(raw: unknown): raw is [string, unknown] {
    return Array.isArray(raw) && raw.length === 2 && raw[0] === 'ok';
}

function isClaimedToken(raw: unknown): boolean {
    if (typeof raw === 'string') return raw === 'claimed' || raw === 'OK';
    // Buffer / Uint8Array — some Valkey clients return bytes
    if (
        raw &&
        typeof raw === 'object' &&
        'toString' in raw &&
        typeof (raw as { toString: () => string }).toString === 'function'
    ) {
        try {
            const s = (raw as { toString: (enc?: string) => string }).toString('utf-8' as never);
            if (s === 'claimed' || s === 'OK') return true;
        } catch {
            // fall through
        }
    }
    return false;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const stateMachine = new StateMachine(requireClient);
