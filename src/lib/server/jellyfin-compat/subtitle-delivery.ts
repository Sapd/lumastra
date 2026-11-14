// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a subtitle stream reaches a Jellyfin client — a port of Jellyfin's
 * `StreamBuilder.GetSubtitleProfile` (MediaBrowser.Model/Dlna/StreamBuilder.cs).
 *
 * PlaybackInfo uses it twice, like Jellyfin's MediaInfoHelper does:
 *   - for the SELECTED subtitle, to decide whether it rules out direct play
 *     (anything but Embed/External/Drop does) and what the TranscodingUrl
 *     carries (`SubtitleStreamIndex` + `SubtitleMethod=Encode` for a burn-in);
 *   - for EVERY subtitle stream, to set its `DeliveryMethod` / `DeliveryUrl`.
 *
 * Differences from Jellyfin, on purpose:
 *   - `Hls` profiles are skipped. Our master.m3u8 has no subtitle renditions, so
 *     answering `Hls` would promise a track that never appears; the stream falls
 *     through to External or Encode instead.
 *   - "Can the transcoder extract this embedded text track" is always yes — the
 *     /Subtitles route extracts any embedded text stream with FFmpeg.
 *   - Codec names are compared through an alias table, because media_streams
 *     holds FFprobe names (`hdmv_pgs_subtitle`, `subrip`) where Jellyfin
 *     clients use Jellyfin's (`pgssub`, `srt`).
 */

import type { ResolveSubtitleOptions } from '$lib/server/services/subtitle-resolver.service';

export type SubtitleDeliveryMethod = 'Encode' | 'Embed' | 'External' | 'Hls' | 'Drop';

export interface SubtitleProfileLike {
    Format: string;
    Method: string;
    Container?: string | null;
    Language?: string | null;
}

export interface SubtitleStreamLike {
    Codec?: string | null;
    Language?: string | null;
    IsExternal?: boolean | null;
    IsTextSubtitleStream?: boolean | null;
}

export interface SubtitleDeliveryContext {
    /** 'DirectPlay' for the direct-play eligibility check, 'Transcode' for the HLS URL. */
    playMethod: 'DirectPlay' | 'Transcode';
    /** The source container for direct play, the transcoding container (`ts`) otherwise. */
    outputContainer: string | null | undefined;
    /** 'hls' when the transcode is HLS. */
    subProtocol?: string | null;
    /** Infinite (live) sources cannot convert subtitles to a sidecar file. */
    isInfiniteStream?: boolean;
}

export interface ResolvedSubtitleDelivery {
    method: SubtitleDeliveryMethod;
    /** The format the client gets: the profile's for Embed/External, the stream codec for Encode. */
    format: string;
}

const CODEC_ALIASES: Record<string, string> = {
    hdmv_pgs_subtitle: 'pgssub',
    pgs: 'pgssub',
    sup: 'pgssub',
    dvd_subtitle: 'dvdsub',
    vobsub: 'dvdsub',
    dvb_subtitle: 'dvbsub',
    subrip: 'srt',
    webvtt: 'vtt',
};

/** Jellyfin's codec spelling for an FFprobe or Jellyfin subtitle codec name. */
export function normalizeSubtitleCodec(codec: string | null | undefined): string {
    const c = (codec ?? '').trim().toLowerCase();
    return CODEC_ALIASES[c] ?? c;
}

function sameCodec(a: string | null | undefined, b: string | null | undefined): boolean {
    return normalizeSubtitleCodec(a) === normalizeSubtitleCodec(b);
}

/** Jellyfin's `MediaStream.IsTextFormat`. */
export function isTextSubtitleFormat(format: string | null | undefined): boolean {
    const c = (format ?? '').toLowerCase();
    if (c.includes('microdvd')) return true;
    return !(
        c.includes('pgs') ||
        c.includes('dvdsub') ||
        c.includes('dvbsub') ||
        c === 'sub' ||
        c === 'sup' ||
        c === 'dvb_subtitle' ||
        c === 'dvd_subtitle'
    );
}

function isTextStream(stream: SubtitleStreamLike): boolean {
    return stream.IsTextSubtitleStream ?? isTextSubtitleFormat(stream.Codec);
}

function isPgsOrVobSub(stream: SubtitleStreamLike): boolean {
    const c = normalizeSubtitleCodec(stream.Codec);
    return c === 'pgssub' || c === 'dvdsub';
}

/** Jellyfin's `ContainerHelper.ContainsContainer`: empty = any, a leading `-` negates. */
function containsContainer(
    profileContainers: string | null | undefined,
    value: string | null | undefined,
): boolean {
    if (!profileContainers?.trim()) return true;
    let list = profileContainers.trim();
    const negate = list.startsWith('-');
    if (negate) list = list.slice(1);
    const values = (value ?? '')
        .toLowerCase()
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    const hit = list
        .toLowerCase()
        .split(',')
        .map((v) => v.trim())
        .some((c) => values.includes(c));
    return negate ? !hit : hit;
}

/** Jellyfin's `SubtitleProfile.SupportsLanguage`. */
function supportsLanguage(profile: SubtitleProfileLike, language: string | null | undefined) {
    if (!profile.Language?.trim()) return true;
    return containsContainer(profile.Language, language?.trim() || 'und');
}

/** Jellyfin's `IsSubtitleEmbedSupported`: only Matroska output carries embedded subs. */
function isSubtitleEmbedSupported(container: string | null | undefined): boolean {
    if (!container) return false;
    if (containsContainer(container, 'ts,mpegts,mp4')) return false;
    return containsContainer(container, 'mkv,matroska');
}

function canConsiderEmbed(stream: SubtitleStreamLike, ctx: SubtitleDeliveryContext): boolean {
    const isHls = ctx.subProtocol?.toLowerCase() === 'hls';
    if (stream.IsExternal) {
        return (
            ctx.playMethod === 'Transcode' &&
            !isHls &&
            isSubtitleEmbedSupported(ctx.outputContainer)
        );
    }
    return ctx.playMethod !== 'Transcode' || !isHls;
}

/** Jellyfin's `MediaStream.SupportsSubtitleConversionTo` — ASS/SSA in or out never converts. */
function supportsConversionTo(stream: SubtitleStreamLike, toFormat: string): boolean {
    if (!isTextStream(stream)) return false;
    const from = normalizeSubtitleCodec(stream.Codec);
    const to = normalizeSubtitleCodec(toFormat);
    return !(from === 'ass' || from === 'ssa' || to === 'ass' || to === 'ssa');
}

/** Formats the /Subtitles route can convert an embedded or sidecar text track into. */
function canServeConvertedAs(format: string): boolean {
    const to = normalizeSubtitleCodec(format);
    return to === 'vtt' || to === 'srt';
}

function findEmbedProfile(
    stream: SubtitleStreamLike,
    profiles: readonly SubtitleProfileLike[],
    ctx: SubtitleDeliveryContext,
    allowConversion: boolean,
): SubtitleProfileLike | undefined {
    const text = isTextStream(stream);
    return profiles.find((profile) => {
        if (!supportsLanguage(profile, stream.Language)) return false;
        if (profile.Method !== 'Embed') return false;
        if (!containsContainer(profile.Container, ctx.outputContainer)) return false;
        if (ctx.playMethod === 'Transcode' && !isSubtitleEmbedSupported(ctx.outputContainer)) {
            return false;
        }
        if (!allowConversion) {
            return (
                text === isTextSubtitleFormat(profile.Format) &&
                sameCodec(profile.Format, stream.Codec)
            );
        }
        return text && supportsConversionTo(stream, profile.Format);
    });
}

function findExternalProfile(
    stream: SubtitleStreamLike,
    profiles: readonly SubtitleProfileLike[],
    ctx: SubtitleDeliveryContext,
    allowConversion: boolean,
): SubtitleProfileLike | undefined {
    const text = isTextStream(stream);
    for (const profile of profiles) {
        // Hls is deliberately not offered — see the module comment.
        if (profile.Method !== 'External') continue;
        if (!supportsLanguage(profile, stream.Language)) continue;
        // Jellyfin skips embedded tracks its transcoder cannot extract; ours
        // extracts every text track, and PGS/VobSub are always extractable.
        if (
            !stream.IsExternal &&
            ctx.playMethod === 'Transcode' &&
            !text &&
            !isPgsOrVobSub(stream)
        ) {
            continue;
        }
        if (text !== isTextSubtitleFormat(profile.Format)) continue;

        if (sameCodec(stream.Codec, profile.Format)) return profile;
        if (!allowConversion || ctx.isInfiniteStream) continue;
        if (supportsConversionTo(stream, profile.Format) && canServeConvertedAs(profile.Format)) {
            return profile;
        }
    }
    return undefined;
}

/**
 * Jellyfin's `StreamBuilder.GetSubtitleProfile`: Embed when the output can carry
 * the codec and the profile allows it, else External (as-is, then converted),
 * else Encode (burn-in).
 */
export function resolveSubtitleDelivery(
    stream: SubtitleStreamLike,
    profiles: readonly SubtitleProfileLike[],
    ctx: SubtitleDeliveryContext,
): ResolvedSubtitleDelivery {
    if (canConsiderEmbed(stream, ctx)) {
        const embed =
            findEmbedProfile(stream, profiles, ctx, false) ??
            findEmbedProfile(stream, profiles, ctx, true);
        if (embed) return { method: 'Embed', format: embed.Format };
    }

    const external =
        findExternalProfile(stream, profiles, ctx, false) ??
        findExternalProfile(stream, profiles, ctx, true);
    if (external) return { method: 'External', format: external.Format };

    return { method: 'Encode', format: stream.Codec ?? '' };
}

/**
 * Our HLS engine burns in only embedded bitmap subtitles (PGS, VobSub): text
 * tracks and sidecar files are never rendered into the picture
 * (hls/playback.service.ts skips them as "missing/non-bitmap").
 */
export function engineCanBurnIn(stream: SubtitleStreamLike): boolean {
    if (stream.IsExternal) return false;
    const codec = normalizeSubtitleCodec(stream.Codec);
    return codec === 'pgssub' || codec === 'dvdsub';
}

/**
 * {@link resolveSubtitleDelivery}, limited to what this server can deliver.
 *
 * Jellyfin answers Encode for any track the client cannot embed or fetch as
 * is — an ASS track for Android TV without libass, a sidecar in a format it
 * lacks. Jellyfin then burns it in; our engine can only for embedded bitmaps.
 * For anything else, Encode would rule out direct play and still show no
 * subtitles (2026-10-02 review). So:
 * - a text track goes out as an External sidecar in the first text format the
 *   client takes External (the /Subtitles route converts to vtt/srt);
 * - otherwise null: no delivery decision — leave the track as it was and do
 *   not let it affect direct play or the TranscodingUrl.
 */
export function resolveDeliverableSubtitle(
    stream: SubtitleStreamLike,
    profiles: readonly SubtitleProfileLike[],
    ctx: SubtitleDeliveryContext,
): ResolvedSubtitleDelivery | null {
    const delivery = resolveSubtitleDelivery(stream, profiles, ctx);
    if (delivery.method !== 'Encode' || engineCanBurnIn(stream)) return delivery;
    if (isTextStream(stream) && !ctx.isInfiniteStream) {
        const external = profiles.find(
            (profile) =>
                profile.Method === 'External' &&
                supportsLanguage(profile, stream.Language) &&
                canServeConvertedAs(profile.Format),
        );
        if (external) return { method: 'External', format: external.Format };
    }
    return null;
}

/** Methods that keep direct play possible (Jellyfin: anything but Drop/External/Embed rules it out). */
export function allowsDirectPlay(method: SubtitleDeliveryMethod): boolean {
    return method === 'Embed' || method === 'External' || method === 'Drop';
}

export type SubtitleFormat = NonNullable<ResolveSubtitleOptions['format']>;

/**
 * The output format named by `Stream.{ext}`. PlaybackInfo hands out sidecar URLs
 * in the client's SubtitleProfile format (`Stream.ass` for JASSUB, `Stream.pgssub`
 * for jellyfin-web's PGS renderer), so the extension has to be honoured.
 * Anything unrecognised gets WebVTT, as before.
 */
const FORMAT_BY_EXTENSION: Record<string, SubtitleFormat> = {
    vtt: 'vtt',
    webvtt: 'vtt',
    srt: 'srt',
    subrip: 'srt',
    ass: 'ass',
    ssa: 'ass',
    pgssub: 'pgssub',
    pgs: 'pgssub',
    sup: 'pgssub',
    sub: 'sub',
    dvdsub: 'sub',
};

export function formatFromStreamFile(streamFile: string | undefined): SubtitleFormat {
    const ext = streamFile?.split('.').pop()?.toLowerCase() ?? '';
    return FORMAT_BY_EXTENSION[ext] ?? 'vtt';
}
