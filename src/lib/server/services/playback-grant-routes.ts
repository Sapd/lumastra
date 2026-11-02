// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Delivery classes are explicit: a playback resource's JSON siblings never accept grants. */
export interface PlaybackGrantRoute {
    mediaId?: string;
    liveTvViewerKey?: string;
    playbackSessionId?: string;
    audiobookSessionId?: string;
    kind: 'video' | 'music' | 'audiobook' | 'live' | 'preview';
    /** Exact HLS resources served by the preview session; never subtitles or trickplay. */
    previewDelivery?: boolean;
    /** Lifecycle routes opt in to one write method; delivery defaults to GET/HEAD. */
    methods?: readonly string[];
    /** A Live TV delivery URL whose session has ended: the grant answers `session_ended`. */
    sessionEnded?: boolean;
}

export interface LivetvPlaybackSession {
    playbackSessionId: string;
    feedId: string;
    active: boolean;
    viewerKey?: string;
}
export type LivetvPlaybackSessionResolver = (
    playbackSessionId: string,
) => Promise<LivetvPlaybackSession | null>;

/** Keep the heavy Live TV service graph out of preview and other delivery modules. */
export const getLivetvPlaybackSession: LivetvPlaybackSessionResolver = async (id) => {
    const { getLiveTvSessionService } = await import('./livetv/livetv-session.service.js');
    const session = await getLiveTvSessionService().getPlaybackSession(id);
    return session
        ? {
              playbackSessionId: session.sessionId,
              feedId: session.feedId,
              active: session.state === 'active',
              viewerKey: session.viewerKey,
          }
        : null;
};

export type PlaybackGrantRouteClassifier = (url: URL) => PlaybackGrantRoute | null;
const additionalClasses: PlaybackGrantRouteClassifier[] = [];

/** Packages adding timeline/subtitle delivery register their exact delivery paths here. */
export function registerPlaybackGrantRoute(classifier: PlaybackGrantRouteClassifier): () => void {
    additionalClasses.push(classifier);
    return () => {
        const index = additionalClasses.indexOf(classifier);
        if (index !== -1) additionalClasses.splice(index, 1);
    };
}

export async function resolvePlaybackGrantRoute(
    url: URL,
    resolveLiveSession: LivetvPlaybackSessionResolver = getLivetvPlaybackSession,
): Promise<PlaybackGrantRoute | null> {
    if (/%2f|%5c|%2e%2e|\.\./i.test(url.pathname)) return null;
    const path = url.pathname.replace(/^.*?\/api\/(?:v1\/)?/, '/');
    if (path === url.pathname) return null;
    const playbackSessionId = url.searchParams.get('PlaySessionId') ?? undefined;
    const preview = path.match(/^\/playback\/previews\/([^/]+)(\/keepalive)?$/);
    if (preview) {
        if (playbackSessionId && playbackSessionId !== preview[1]) return null;
        return {
            playbackSessionId: preview[1],
            kind: 'preview',
            methods: preview[2] ? ['POST'] : ['DELETE'],
        };
    }
    const legacySubtitle = path.match(/^\/playback\/subtitles\/([^/]+)\/[^/]+$/);
    if (legacySubtitle)
        return { mediaId: legacySubtitle[1].toLowerCase(), playbackSessionId, kind: 'video' };
    const video = path.match(
        /^\/(?:Videos|playback)\/([^/]+)\/(?:hls(?:\.m3u8)?(?:\/.*)?|avp\/[^/]+\/hls(?:\/.*)?|file|timeline|stream(?:\.[^/]+)?|subtitles\/.*|trickplay\/.*|chapter-image\/[^/]+)$/,
    );
    if (video) {
        const previewDelivery =
            /^\/playback\/[^/]+\/hls\/(?:(?:master|index)\.m3u8|(?:stream_\d+\/)?(?:index\.m3u8|init(?:_\d+)?\.mp4|segment_\d+\.(?:ts|m4s)))$/.test(
                path,
            );
        return {
            mediaId: video[1].toLowerCase(),
            playbackSessionId,
            kind: 'video',
            ...(previewDelivery ? { previewDelivery: true } : {}),
        };
    }
    const music = path.match(
        /^\/music\/(?:tracks\/([^/]+)|radio\/(?:stations\/)?([^/]+))\/stream(?:\/.*)?$/,
    );
    if (music)
        return { mediaId: (music[1] ?? music[2]).toLowerCase(), playbackSessionId, kind: 'music' };
    const audiobook = path.match(/^\/audiobooks\/([^/]+)\/(?:files|remux)\/(?:0|[1-9]\d*)$/);
    const audiobookHls = path.match(/^\/audiobook\/([^/]+)\/hls\/playback\/([^/]+)\/[^/]+$/);
    if ((audiobook || audiobookHls) && /\/api\/v1\//.test(url.pathname)) {
        if (!playbackSessionId || (audiobookHls && playbackSessionId !== audiobookHls[2]))
            return null;
        return {
            mediaId: (audiobook?.[1] ?? audiobookHls![1]).toLowerCase(),
            playbackSessionId,
            kind: 'audiobook',
        };
    }
    const live = path.match(/^\/livetv\/channels\/([^/]+)\/stream\/.+$/);
    if (live) {
        if (!playbackSessionId) return null;
        const session = await resolveLiveSession(playbackSessionId);
        if (
            session &&
            (session.feedId !== live[1] || session.playbackSessionId !== playbackSessionId)
        )
            return null;
        // Ended (or already forgotten) session: still a delivery URL, so the grant check can
        // tell the player its session ended instead of calling the URL foreign.
        if (!session?.active) return { playbackSessionId, kind: 'live', sessionEnded: true };
        return {
            playbackSessionId,
            kind: 'live',
            ...(session.viewerKey ? { liveTvViewerKey: session.viewerKey } : {}),
        };
    }
    for (const classify of additionalClasses) {
        const route = classify(url);
        if (route) return route;
    }
    return null;
}
