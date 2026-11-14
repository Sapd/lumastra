// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `whats_on_tv` tool — current and upcoming Live TV programming (EPG).
 *
 * With a channel name it resolves the channel via the same visibility-scoped
 * channel search the Live TV UI uses (`searchChannels`, trigram + aliases) and
 * returns that channel's now-playing program plus the next few. Without a
 * channel it lists what is currently airing across the user's VISIBLE channels
 * (hidden channels are excluded by intersecting with `getAllVisibleChannels`).
 *
 * Only registered when the caller may view Live TV (`accessCtx.liveTvAllowed`),
 * and defensively re-checks that flag. TEXT-ONLY.
 *
 * @module server/assistant/assistant-tools/whats-on-tv.tool
 */

import {
    whatsOnTvArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type WhatsOnTvArgs,
} from '../../../schemas/assistant-tools.js';
import {
    searchChannels,
    getAllVisibleChannels,
} from '../../database/queries/livetv-channels.queries.js';
import {
    getCurrentProgram,
    getProgramsByDateRange,
    getCurrentProgramsForAllChannels,
    getGuidePrograms,
    type ProgramRow,
} from '../../database/queries/livetv-programs.queries.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';

/** How many upcoming programs to list for a single channel. */
const UPCOMING_PER_CHANNEL = 3;
/** Upcoming window for a single channel's "next" programs. */
const UPCOMING_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Cap on channels listed in the "all channels" overview. */
const MAX_CHANNELS = 25;

/**
 * Resolve `atTime` + `daysAhead` to an absolute instant in the SERVER's local
 * zone, or null when the caller asked for "now".
 *
 * Without this the tool answered every question with what is on RIGHT NOW —
 * so "was läuft heute Abend um 20:15?" asked at 15:00 returned the afternoon
 * schedule, with nothing in the payload to reveal the mismatch, and the model
 * presented it as tonight's line-up.
 */
function resolveWindow(args: WhatsOnTvArgs): { at: Date; label: string } | null {
    if (!args.atTime && !args.daysAhead) return null;
    const at = new Date();
    if (args.daysAhead) at.setDate(at.getDate() + args.daysAhead);
    if (args.atTime) {
        const [h, m] = args.atTime.split(':').map(Number);
        at.setHours(h, m, 0, 0);
    }
    const day =
        args.daysAhead === undefined || args.daysAhead === 0
            ? 'today'
            : args.daysAhead === 1
              ? 'tomorrow'
              : `in ${args.daysAhead} days`;
    return { at, label: args.atTime ? `${day} at ${args.atTime}` : day };
}

function fmtProgram(p: ProgramRow): {
    title: string;
    start: string;
    end: string;
    description?: string;
} {
    return {
        title: p.title,
        start: p.start_time.toISOString(),
        end: p.end_time.toISOString(),
        description: p.description ?? undefined,
    };
}

export const whatsOnTvTool: AssistantTool<WhatsOnTvArgs> = {
    name: ASSISTANT_TOOL_NAMES.WHATS_ON_TV,
    description:
        'Live TV: what is on now (and next). Pass a channel name ("ZDF", "Das Erste") to get that channel\'s current + upcoming programs; omit it to list what is airing right now across the user\'s channels. Use for "what\'s on ZDF", "what\'s on TV right now".',
    argsSchema: whatsOnTvArgsSchema,

    async execute(
        args: WhatsOnTvArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        if (!ctx.accessCtx.liveTvAllowed) {
            return {
                summaryForModel: JSON.stringify({
                    available: false,
                    note: 'Live TV is not available to this user.',
                }),
            };
        }

        // ---- Single channel: now + next -------------------------------------
        if (args.channel?.trim()) {
            const matches = await searchChannels(ctx.sql, args.channel, 5);
            const channel = matches[0];
            if (!channel) {
                return {
                    summaryForModel: JSON.stringify({
                        available: true,
                        found: false,
                        note: `No visible channel matching "${args.channel}".`,
                    }),
                };
            }

            const window = resolveWindow(args);
            const anchor = window?.at ?? new Date();
            const [currentNow, upcomingRaw] = await Promise.all([
                window ? Promise.resolve(null) : getCurrentProgram(ctx.sql, channel.id),
                getProgramsByDateRange(
                    ctx.sql,
                    channel.id,
                    anchor,
                    new Date(anchor.getTime() + UPCOMING_WINDOW_MS),
                ),
            ]);
            // For a requested time, "now" is whatever is airing AT that instant.
            const current = window
                ? (upcomingRaw.find((p) => p.start_time <= anchor && p.end_time > anchor) ?? null)
                : currentNow;

            const upcoming = upcomingRaw
                .filter((p) => p.start_time > anchor)
                .slice(0, UPCOMING_PER_CHANNEL)
                .map(fmtProgram);

            ctx.logger?.debug('whats_on_tv (channel) executed', {
                query: args.channel,
                channel: channel.name,
                hasCurrent: Boolean(current),
            });

            return {
                summaryForModel: JSON.stringify({
                    available: true,
                    found: true,
                    channel: channel.name,
                    // Always state which instant this describes, so a "now"
                    // answer can never be relayed as a scheduled-time answer.
                    window: window?.label ?? 'right now',
                    windowStart: anchor.toISOString(),
                    now: current ? fmtProgram(current) : null,
                    next: upcoming,
                    // Name the SAME instant the `window` field above does. A
                    // hardcoded "right now" contradicted it whenever atTime or
                    // daysAhead moved the anchor, and the model relays the
                    // sentence, not the field — so a question about Friday came
                    // back as "nothing on right now".
                    note: current
                        ? undefined
                        : `No guide data for what is on this channel ${window?.label ?? 'right now'}.`,
                }),
            };
        }

        // ---- All channels: at the requested instant, else right now ---------
        const allWindow = resolveWindow(args);
        const allAnchor = allWindow?.at ?? new Date();
        const [visible, currentAll] = await Promise.all([
            getAllVisibleChannels(ctx.sql),
            allWindow
                ? // getGuidePrograms is already visibility-scoped; a 1-minute
                  // slice around the instant yields whatever is mid-broadcast.
                  getGuidePrograms(ctx.sql, allAnchor, new Date(allAnchor.getTime() + 60 * 1000))
                : getCurrentProgramsForAllChannels(ctx.sql),
        ]);
        const nameById = new Map(visible.map((c) => [c.id, c.name]));

        // Intersect with visible channels FIRST (hidden-channel programs are
        // dropped here — getCurrentProgramsForAllChannels is not visibility-
        // scoped), then cap. `truncated` reflects the cap, not the hidden drop.
        const visiblePrograms = currentAll.filter((p) => nameById.has(p.channel_id));
        const onNow = visiblePrograms.slice(0, MAX_CHANNELS).map((p) => ({
            channel: nameById.get(p.channel_id),
            ...fmtProgram(p),
        }));

        ctx.logger?.debug('whats_on_tv (all) executed', {
            visibleChannels: visible.length,
            onNow: onNow.length,
        });

        return {
            summaryForModel: JSON.stringify({
                available: true,
                found: onNow.length > 0,
                // Names the instant described. Without it the model could not
                // tell "on now" from "on at the time you asked about".
                window: allWindow?.label ?? 'right now',
                windowStart: allAnchor.toISOString(),
                onNow,
                truncated: visiblePrograms.length > MAX_CHANNELS,
                // Same instant as the `window` field, for the same reason.
                note:
                    onNow.length === 0
                        ? `No guide data for any visible channel ${allWindow?.label ?? 'right now'}.`
                        : undefined,
            }),
        };
    },
};
