// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Implicit resume handoff for an open, paused player: when the viewer comes
 * back to the tab, ask the server whether they carried on from here on another
 * device after this tab's last action, and follow: a seek in place, or a jump
 * to the later episode, both with a way back. The server decides by chain
 * continuity (resume-handoff.service.ts); this module decides when to ask and
 * whether the answer still applies. It runs in front of the series marker
 * re-check (`marker-recheck.ts`), without its 10-minute gate.
 * Design: docs/superpowers/specs/2026-10-22-implicit-resume-handoff.md.
 */

import type { ResumeHandoffTarget } from '$lib/schemas/resume-handoff';
import { buildEpisodeSlug } from '$lib/utils/url-slugs';
import { WATCH_ENTRY_PARAM, type WatchEntry } from '$lib/stores/watch-entry';
import { RESUME_RECHECK_APPLY_WINDOW_MS, episodeCode, type RecheckTrigger } from './marker-recheck';

/** A hide or blur shorter than this (a click into a native control, a quick tab peek) never asks. */
export const HANDOFF_MIN_AWAY_MS = 3000;

/** A play press asks only after a pause at least this long. */
export const HANDOFF_MIN_PAUSE_MS = 30_000;

/** At most one request per this interval (the triggers can fire together). */
export const HANDOFF_MIN_INTERVAL_MS = 10_000;

/** The playhead may drift this much between request and answer and still count as unchanged. */
export const HANDOFF_POSITION_TOLERANCE_MS = 2000;

/** A handoff older than this names its age in the toast. */
export const HANDOFF_SHOW_AGE_AFTER_MS = 12 * 60 * 60_000;

/** Landing param carrying the handoff's age to the jump target's toast. */
export const HANDOFF_AGE_PARAM = 'age';

/** Landing param carrying the followed chain, so the jump's Back declines it. */
export const HANDOFF_CHAIN_PARAM = 'hchain';

/**
 * Landing param that remounts the player on a same-item handoff. A seek in
 * place would keep this tab's play session, which is older than the other
 * device's on the same item: its first heartbeat after Play would lose and
 * the tab would pause itself as "superseded". A fresh mount starts a new
 * session (and grant) at the handed-off position.
 */
export const HANDOFF_REMOUNT_PARAM = 'hn';

/** Which event asked: a return to the tab (visibility, focus, bfcache) or a play press. */
export type HandoffTrigger = Extract<RecheckTrigger, 'return' | 'resume'>;

export interface HandoffContext {
    /** Item on screen (episode or movie); null for anything without a handoff. */
    mediaId: () => string | null;
    deviceId: () => string;
    positionMs: () => number;
    isPlaying: () => boolean;
    watchPartyActive: () => boolean;
    /** The tab was opened to keep watching (entry not explicit); an explicit pick never follows. */
    isLinear: () => boolean;
    /** Epoch ms (local clock) of this tab's last own action: landing, play, pause, seek. */
    lastActionAt: () => number;
    /** Chains this tab undid (their `chainId`); never followed again. */
    isDeclined: (chainId: string) => boolean;
    entry: () => WatchEntry;
    seriesTitle: () => string | null;
    episodeCode: () => string | null;
}

export type HandoffDecision =
    | {
          kind: 'seek';
          positionMs: number;
          fromPositionMs: number;
          deviceName: string | null;
          chainId: string;
          /** How long ago the other device moved; shown when ≥ HANDOFF_SHOW_AGE_AFTER_MS. */
          ageMs: number;
      }
    | { kind: 'jump'; url: string }
    | { kind: 'stay' };

const STAY: HandoffDecision = { kind: 'stay' };

/** Whether this tab may ask at all. A playing player asks only on the play press itself. */
export function shouldCheckHandoff(ctx: HandoffContext, trigger: HandoffTrigger): boolean {
    if (ctx.watchPartyActive() || !ctx.isLinear() || !ctx.mediaId()) return false;
    return trigger === 'resume' || !ctx.isPlaying();
}

/** Path (under the internal API prefix) of this tab's handoff request. */
export function handoffRequestPath(input: {
    mediaId: string;
    positionMs: number;
    deviceId: string;
    idleMs: number;
}): string {
    const query = new URLSearchParams({
        mediaId: input.mediaId,
        positionMs: String(Math.max(0, Math.floor(input.positionMs))),
        deviceId: input.deviceId,
        idleMs: String(Math.max(0, Math.floor(input.idleMs))),
    });
    return `/me/resume-handoff?${query.toString()}`;
}

/**
 * Where a handoff lands. A later episode uses the marker-jump landing
 * (`resolved=series`: "Continued at … — Back to …"); the same item uses the
 * seek landing (`resolved=seek`: "Resumed at … — Undo") with a remount nonce.
 * Both carry `from` (lands paused, undo target), the target position, the
 * tab's entry, the chain (declined on undo) and, when old, the age.
 */
function landingUrl(
    ctx: HandoffContext,
    target: ResumeHandoffTarget,
    from: { mediaId: string; positionMs: number },
    ageMs: number,
): string {
    const query = new URLSearchParams();
    const sameItem = target.relation === 'same_media';
    const numbered = target.seasonNumber !== undefined && target.episodeNumber !== undefined;
    const title = ctx.seriesTitle();
    if (title && numbered) {
        query.set('slug', buildEpisodeSlug(title, target.seasonNumber!, target.episodeNumber!));
    }
    query.set('resolved', sameItem ? 'seek' : 'series');
    query.set('seekMs', String(Math.max(0, Math.floor(target.positionMs))));
    query.set('from', from.mediaId);
    query.set('fromPos', String(Math.max(0, Math.floor(from.positionMs))));
    const fromCode = ctx.episodeCode();
    if (fromCode && !sameItem) query.set('fmk', fromCode);
    if (numbered && !sameItem) {
        query.set('mk', episodeCode(target.seasonNumber!, target.episodeNumber!));
    }
    if (target.deviceName) query.set('dev', target.deviceName);
    if (ageMs >= HANDOFF_SHOW_AGE_AFTER_MS) query.set(HANDOFF_AGE_PARAM, String(Math.floor(ageMs)));
    query.set(HANDOFF_CHAIN_PARAM, target.chainId);
    if (sameItem) query.set(HANDOFF_REMOUNT_PARAM, `${target.chainId}:${target.updatedAt}`);
    query.set(WATCH_ENTRY_PARAM, ctx.entry());
    return `/watch/${target.mediaId}?${query.toString()}`;
}

/**
 * Decide what to do with an answer. Applies only when nothing changed in the
 * tab meanwhile (same item, same playhead, no new action), the chain was not
 * undone here before, and, for a play press, only within
 * {@link RESUME_RECHECK_APPLY_WINDOW_MS} of the press.
 */
export function decideHandoff(
    ctx: HandoffContext,
    target: ResumeHandoffTarget | undefined,
    request: {
        trigger: HandoffTrigger;
        mediaId: string;
        positionMs: number;
        startedAt: number;
        /** `ctx.lastActionAt()` when the request started, before a play press counts as an action. */
        lastActionAt: number;
    },
    now: number,
): HandoffDecision {
    if (!target || ctx.isDeclined(target.chainId)) return STAY;
    if (ctx.watchPartyActive() || ctx.mediaId() !== request.mediaId) return STAY;
    // The viewer acted while the request was in flight (other than the play press).
    if (request.trigger !== 'resume' && ctx.lastActionAt() !== request.lastActionAt) return STAY;

    if (ctx.isPlaying()) {
        if (request.trigger !== 'resume') return STAY;
        if (now - request.startedAt > RESUME_RECHECK_APPLY_WINDOW_MS) return STAY;
    } else if (Math.abs(ctx.positionMs() - request.positionMs) > HANDOFF_POSITION_TOLERANCE_MS) {
        return STAY;
    }

    const ageMs = Math.max(0, Date.parse(target.serverNow) - Date.parse(target.updatedAt) || 0);
    // Another episode of this tab's combined file: seek in place (this tab's
    // session is on a different item, so it cannot be superseded by it).
    if (target.relation === 'later_episode' && target.sameFileAsFrom) {
        return {
            kind: 'seek',
            positionMs: target.positionMs,
            fromPositionMs: request.positionMs,
            deviceName: target.deviceName ?? null,
            chainId: target.chainId,
            ageMs,
        };
    }
    return { kind: 'jump', url: landingUrl(ctx, target, request, ageMs) };
}

/** Fetch and decide. Never throws: a failed request stays. */
export async function resolveHandoff(
    ctx: HandoffContext,
    fetchHandoff: (path: string) => Promise<ResumeHandoffTarget | undefined>,
    trigger: HandoffTrigger,
    now: () => number = Date.now,
): Promise<HandoffDecision> {
    if (!shouldCheckHandoff(ctx, trigger)) return STAY;
    const mediaId = ctx.mediaId();
    if (!mediaId) return STAY;
    // Captured synchronously, before the caller records a play press as an action.
    const request = {
        trigger,
        mediaId,
        positionMs: ctx.positionMs(),
        startedAt: now(),
        lastActionAt: ctx.lastActionAt(),
    };
    let target: ResumeHandoffTarget | undefined;
    try {
        target = await fetchHandoff(
            handoffRequestPath({
                mediaId,
                positionMs: request.positionMs,
                deviceId: ctx.deviceId(),
                idleMs: request.startedAt - request.lastActionAt,
            }),
        );
    } catch {
        return STAY;
    }
    return decideHandoff(ctx, target, request, now());
}

/** One request per {@link HANDOFF_MIN_INTERVAL_MS}; a play press after a long pause always passes. */
export class HandoffThrottle {
    private lastAt: number | null = null;

    allow(trigger: HandoffTrigger, now: number): boolean {
        if (
            trigger !== 'resume' &&
            this.lastAt !== null &&
            now - this.lastAt < HANDOFF_MIN_INTERVAL_MS
        ) {
            return false;
        }
        this.lastAt = now;
        return true;
    }
}

const DECLINED_KEY = 'watchHandoffDeclined';
const DECLINED_CAP = 50;

function readDeclined(): string[] {
    try {
        const parsed: unknown = JSON.parse(sessionStorage.getItem(DECLINED_KEY) ?? '[]');
        return Array.isArray(parsed)
            ? parsed.filter((v): v is string => typeof v === 'string')
            : [];
    } catch {
        // best-effort: unreadable storage declines nothing
        return [];
    }
}

/** This tab undid a handoff from `chainId`: never follow that chain again (per tab). */
export function declineHandoffChain(chainId: string): void {
    const list = readDeclined().filter((id) => id !== chainId);
    list.push(chainId);
    try {
        sessionStorage.setItem(DECLINED_KEY, JSON.stringify(list.slice(-DECLINED_CAP)));
    } catch {
        // best-effort: without storage the next answer may offer the chain again
    }
}

export function isHandoffChainDeclined(chainId: string): boolean {
    return readDeclined().includes(chainId);
}

interface VisibilityTarget extends EventTarget {
    visibilityState: string;
}

/**
 * Calls `onReturn` when the viewer comes back after at least
 * {@link HANDOFF_MIN_AWAY_MS}: the tab becomes visible, the window regains
 * focus (a visible tab in a background window never fires visibilitychange),
 * or a bfcache restore. Returns the uninstall function.
 */
export function installHandoffTriggers(
    onReturn: () => void,
    env: { doc: VisibilityTarget; win: EventTarget; now: () => number },
): () => void {
    let awaySince: number | null = env.doc.visibilityState === 'hidden' ? env.now() : null;

    const leave = (): void => {
        if (awaySince === null) awaySince = env.now();
    };
    const back = (): void => {
        if (awaySince === null) return;
        const away = env.now() - awaySince;
        awaySince = null;
        if (away >= HANDOFF_MIN_AWAY_MS) onReturn();
    };

    const onVisibility = (): void => {
        if (env.doc.visibilityState === 'hidden') leave();
        else back();
    };
    const onPageShow = (event: Event): void => {
        if ('persisted' in event && event.persisted === true) {
            awaySince = null;
            onReturn();
        }
    };

    env.doc.addEventListener('visibilitychange', onVisibility);
    env.win.addEventListener('blur', leave);
    env.win.addEventListener('focus', back);
    env.win.addEventListener('pageshow', onPageShow);
    return () => {
        env.doc.removeEventListener('visibilitychange', onVisibility);
        env.win.removeEventListener('blur', leave);
        env.win.removeEventListener('focus', back);
        env.win.removeEventListener('pageshow', onPageShow);
    };
}
