// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Reconnect rebuilds start a fresh session and follow its delivery URL. */
export interface RebuildStreamSource {
    buildUrl: (forceTranscode: boolean, position: number) => string | Promise<string>;
    initialize: (url: string, position: number) => Promise<void>;
}

export function selectRebuildStreamSource<Info, Method extends string>(opts: {
    lumastra: { info: Info; method: Method } | null;
    buildLumastraUrl: (info: Info, method: Method, position: number) => string | Promise<string>;
    buildLegacyUrl: (forceTranscode: boolean, position: number) => string | Promise<string>;
    initializeHls: (url: string, position: number) => Promise<void>;
    initializeDirectPlay: (url: string) => void;
    /** Read after start: the planner may choose a different method from the probe. */
    isDirectDelivery?: () => boolean;
}): RebuildStreamSource {
    const { lumastra } = opts;
    if (!lumastra) {
        return { buildUrl: opts.buildLegacyUrl, initialize: opts.initializeHls };
    }
    const { info, method } = lumastra;
    return {
        buildUrl: (_forceTranscode, position) => opts.buildLumastraUrl(info, method, position),
        initialize: async (url, position) => {
            if (opts.isDirectDelivery?.() ?? method === 'direct') opts.initializeDirectPlay(url);
            else await opts.initializeHls(url, position);
        },
    };
}
