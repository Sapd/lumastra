// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * "Stream limit reached" at PLAYBACK START for the free tier's /j cap.
 *
 * The same clip mechanism also explains a Live TV provider's own stream limit
 * (`kind: 'livetv_source'`, built from the PlaybackInfo route when the stream
 * proxy refuses a tune); only the text differs.
 *
 * When a Jellyfin client asks for PlaybackInfo and the cap is already used by
 * OTHER live /j sessions, the client gets a MediaSource for a short explanation
 * clip (see stream-limit-clip.ts) instead of the real media, and no transcode is
 * started. A teardown after the fact (`enforceFreemiumStreamLimit`) only looks
 * like a playback error inside a Jellyfin app; the clip says what happened.
 *
 * The existing teardown stays the backstop for races (two clients passing this
 * check at the same moment both get real media; the newer one is torn down).
 *
 * Every clip PlaybackInfo mints a random notice id, stored in Valkey, that is
 * used as BOTH the PlaySessionId and the MediaSource.Id. That lets:
 * - the stream route recognise the clip however the client builds the URL
 *   (`/Videos/{id}/stream`, or `/Videos/{itemId}/stream?mediaSourceId={id}`);
 * - Sessions/Playing|Progress|Stopped ignore the clip's reports, so the clip
 *   creates no play_sessions row, never counts toward the cap and never writes
 *   a 0:15 resume point onto the real item.
 * The id is server-minted and unguessable, so a client cannot claim one to make
 * a real stream's reports invisible to the cap; a client-supplied PlaySessionId
 * that IS a notice id is never reused for real media (see `freshPlaySessionId`).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { cacheGet, cacheSet, hGetAll } from '$lib/server/cache/valkey';
import { config } from '$lib/server/config';
import { getEffectiveEntitlements } from '$lib/server/licensing/entitlements';
import { getLiveJellyfinCompatSessions } from '$lib/server/database/queries/play-sessions.queries';
import { serveFileWithRange } from '$lib/server/utils/http-range';
import { Logger } from '$lib/server/utils/logger';
import type { JellyfinMediaSourceInfo, JellyfinPlaybackInfoResponse } from './types';
import {
    CLIP_DURATION_SECONDS,
    CLIP_HEIGHT,
    CLIP_PLAYLIST,
    CLIP_WIDTH,
    ensureStreamLimitClip,
    noticeText,
    type NoticeKind,
    type NoticeLanguage,
} from './stream-limit-clip';

const logger = Logger.for('JellyfinCompat:StreamLimitNotice');

const NOTICE_PREFIX = 'v1:jf:stream-limit-notice:';
/** Long enough to cover a client that plays the clip, idles, then reports Stopped. */
const NOTICE_TTL_SECONDS = 2 * 60 * 60;
const TICKS_PER_SECOND = 10_000_000;

interface NoticeRecord {
    userId: string;
    /** Absent on records minted before Live TV notices existed. */
    kind?: NoticeKind;
    lang: NoticeLanguage;
    cap: number;
}

function noticeKey(id: string): string {
    return `${NOTICE_PREFIX}${id}`;
}

/** Notice ids are 32 lowercase hex chars — the same shape as a PlaySessionId. */
const NOTICE_ID_RE = /^[0-9a-f]{32}$/;

async function readNotice(id: string | null | undefined): Promise<NoticeRecord | null> {
    if (!id || !NOTICE_ID_RE.test(id)) return null;
    try {
        const raw = await cacheGet(noticeKey(id));
        return raw ? (JSON.parse(raw) as NoticeRecord) : null;
    } catch {
        return null;
    }
}

/** True when this PlaySessionId / MediaSourceId belongs to a limit clip. */
export async function isStreamLimitNoticeId(id: string | null | undefined): Promise<boolean> {
    return (await readNotice(id)) !== null;
}

/**
 * True when a Sessions/Playing|Progress|Stopped report is about a limit clip.
 * Clients echo both ids back; either one is enough.
 */
export async function isStreamLimitNoticeReport(report: {
    playSessionId?: string;
    mediaSourceId?: string;
}): Promise<boolean> {
    return (
        (await isStreamLimitNoticeId(report.playSessionId)) ||
        (await isStreamLimitNoticeId(report.mediaSourceId))
    );
}

/** Real clients send 32-hex or UUID ids; anything else is minted fresh. */
const CLIENT_PLAY_SESSION_ID_RE = /^[\w-]{1,64}$/;

/**
 * Preserve plausible, unused client ids for Jellyfin clients. Replace ids that
 * already map to tokens so a new playback cannot overwrite an existing one.
 * Notice ids are replaced too, or real progress would be mistaken for a clip.
 * Bound length for the indexed client_diagnostics.play_session_id column.
 */
export async function freshPlaySessionId(clientId: string | undefined): Promise<string> {
    if (
        clientId &&
        CLIENT_PLAY_SESSION_ID_RE.test(clientId) &&
        !(await isStreamLimitNoticeId(clientId)) &&
        !(await cacheGet(`directplay:session:${clientId}`)) &&
        Object.keys(await hGetAll(`directplay:session-files:v1:${clientId}`)).length === 0
    )
        return clientId;
    return randomUUID().replace(/-/g, '');
}

/**
 * The /j stream cap, when it is already taken by OTHER live /j sessions; null
 * when this request may start a real stream.
 *
 * "Other" excludes the caller's own live session for this item, so a stream that
 * is already playing re-requesting PlaybackInfo (seek, audio or subtitle switch,
 * version pick) keeps its media. Licensed / enforcement-off installs have no cap
 * and never get here. Fail-open: any error → null (real media; the teardown
 * backstop still applies).
 */
export async function streamCapReachedByOthers(
    sql: postgres.Sql,
    userId: UserId,
    itemId: string,
): Promise<number | null> {
    try {
        const { jellyfinMaxConcurrentStreams: cap } = await getEffectiveEntitlements();
        if (cap === null) return null;
        const sessions = await getLiveJellyfinCompatSessions(sql);
        const others = sessions.filter((s) => !(s.user_id === userId && s.media_id === itemId));
        return others.length >= cap ? cap : null;
    } catch (err) {
        logger.warn('Stream-cap check failed; allowing real media', err as Error);
        return null;
    }
}

/**
 * English unless the server forces German or the client asks for German first.
 * Most Jellyfin apps send no Accept-Language at all, so FORCE_LOCALE is what
 * makes a German household see German.
 */
export function noticeLanguage(request: Request): NoticeLanguage {
    if (config.FORCE_LOCALE === 'de') return 'de';
    if (config.FORCE_LOCALE === 'en') return 'en';
    const accept = request.headers.get('accept-language')?.trim().toLowerCase() ?? '';
    return accept.startsWith('de') ? 'de' : 'en';
}

/** The response a client gets for an item the clip does not fit (audio). */
export function rateLimitedPlaybackInfo(playSessionId: string): JellyfinPlaybackInfoResponse {
    return { PlaySessionId: playSessionId, MediaSources: [], ErrorCode: 'RateLimitExceeded' };
}

/**
 * Build the PlaybackInfo response that plays the limit clip, or null when the
 * clip cannot be produced (no ffmpeg, render failed, Valkey down) — the caller
 * then answers with {@link rateLimitedPlaybackInfo}.
 *
 * The clip renders here on first use (awaited, a few seconds once) so the URLs
 * handed out always resolve.
 */
export async function buildStreamLimitPlaybackInfo(params: {
    /** Which limit the clip explains. Default: the free tier's /j cap. */
    kind?: NoticeKind;
    userId: string;
    /** The limit being explained — the /j cap, or the provider's stream limit. */
    cap: number;
    lang: NoticeLanguage;
    /** The item the client asked for (logged only). */
    itemId: string;
}): Promise<JellyfinPlaybackInfoResponse | null> {
    const kind = params.kind ?? 'jellyfin_cap';
    try {
        await ensureStreamLimitClip(kind, params.lang, params.cap);
    } catch (err) {
        logger.warn('Stream-limit clip unavailable; falling back to an error', err as Error);
        return null;
    }

    const id = randomBytes(16).toString('hex');
    const record: NoticeRecord = {
        userId: params.userId,
        kind,
        lang: params.lang,
        cap: params.cap,
    };
    const stored = await cacheSet(noticeKey(id), JSON.stringify(record), NOTICE_TTL_SECONDS);
    if (!stored) return null;

    const title = noticeText(kind, params.lang, params.cap).title;
    const source: JellyfinMediaSourceInfo = {
        Id: id,
        Container: 'mp4',
        Protocol: 'File',
        Type: 'Default',
        Name: title,
        RunTimeTicks: CLIP_DURATION_SECONDS * TICKS_PER_SECOND,
        IsRemote: false,
        ReadAtNativeFramerate: false,
        IgnoreDts: false,
        IgnoreIndex: false,
        GenPtsInput: false,
        IsInfiniteStream: false,
        RequiresOpening: false,
        RequiresClosing: false,
        RequiresLooping: false,
        SupportsProbing: true,
        HasSegments: false,
        VideoType: 'VideoFile',
        SupportsDirectPlay: true,
        SupportsDirectStream: true,
        SupportsTranscoding: true,
        DirectStreamUrl: `/Videos/${id}/stream?static=true&mediaSourceId=${id}&playSessionId=${id}`,
        // Clients that only follow TranscodingUrl (or cannot open MP4) get the
        // same clip as a short VOD HLS. Pre-segmented — no transcode starts.
        TranscodingUrl: `/LumastraNotice/${id}/${CLIP_PLAYLIST}`,
        TranscodingContainer: 'ts',
        TranscodingSubProtocol: 'hls',
        MediaStreams: [
            {
                Index: 0,
                Type: 'Video',
                Codec: 'h264',
                Profile: 'Main',
                Width: CLIP_WIDTH,
                Height: CLIP_HEIGHT,
                AspectRatio: '16:9',
                VideoRange: 'SDR',
                VideoRangeType: 'SDR',
                IsDefault: true,
                IsForced: false,
                IsExternal: false,
                IsInterlaced: false,
                IsHearingImpaired: false,
                IsOriginal: false,
                IsTextSubtitleStream: false,
                SupportsExternalStream: false,
                DisplayTitle: title,
            },
            {
                Index: 1,
                Type: 'Audio',
                Codec: 'aac',
                Language: params.lang === 'de' ? 'ger' : 'eng',
                VideoRange: 'Unknown',
                VideoRangeType: 'Unknown',
                IsDefault: true,
                IsForced: false,
                IsExternal: false,
                IsInterlaced: false,
                IsHearingImpaired: false,
                IsOriginal: false,
                IsTextSubtitleStream: false,
                SupportsExternalStream: false,
                DisplayTitle:
                    params.lang === 'de' ? 'Deutsch - AAC - Stereo' : 'English - AAC - Stereo',
            },
        ],
        // No DefaultAudioStreamIndex — see the PlaybackInfo route: Android TV
        // restart-loops on any non-(-1) default.
    };

    logger.info('Stream limit reached — serving the limit clip', {
        kind,
        userId: params.userId,
        itemId: params.itemId,
        cap: params.cap,
        lang: params.lang,
    });
    return { PlaySessionId: id, MediaSources: [source] };
}

const SEGMENT_RE = /^seg-\d{3}\.ts$/;

/**
 * Serve one file of a notice's clip: the MP4 (`clip.mp4`, with Range support),
 * the HLS playlist or one of its segments. Null when `id` is not a live notice
 * or `file` is not part of a clip — the caller falls through / 404s.
 */
export async function serveStreamLimitClipFile(
    id: string | null | undefined,
    file: string,
    request: Request,
): Promise<Response | null> {
    const notice = await readNotice(id);
    if (!notice) return null;
    if (file !== 'clip.mp4' && file !== CLIP_PLAYLIST && !SEGMENT_RE.test(file)) return null;

    let clip;
    try {
        clip = await ensureStreamLimitClip(notice.kind ?? 'jellyfin_cap', notice.lang, notice.cap);
    } catch (err) {
        logger.warn('Stream-limit clip unavailable at serve time', err as Error);
        return new Response('Clip unavailable', { status: 503 });
    }

    const contentType =
        file === 'clip.mp4'
            ? 'video/mp4'
            : file === CLIP_PLAYLIST
              ? 'application/vnd.apple.mpegurl'
              : 'video/mp2t';
    try {
        return await serveFileWithRange(`${clip.dir}/${file}`, request, {
            contentType,
            headers: { 'Cache-Control': 'private, max-age=3600' },
        });
    } catch {
        return null;
    }
}

export const __test = { NOTICE_PREFIX, noticeKey };
