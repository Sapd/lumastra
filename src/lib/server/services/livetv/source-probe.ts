// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    fetchSsrfValidatedText,
    M3U_MAX_FETCH_BYTES,
    XMLTV_MAX_FETCH_BYTES,
} from './fetch-source.js';

const logger = Logger.for('LiveTvSourceProbe');

/** Never return upstream bodies or exception text: either can contain credentials. */
export async function probeLiveTvFeed(
    url: string,
    feed: 'M3U' | 'XMLTV',
): Promise<string | undefined> {
    let content: string;
    try {
        content = await fetchSsrfValidatedText(url, {
            sourceId: 'setup',
            logger,
            contentLabel: feed,
            fetchFailLogMessage: 'Live TV setup probe failed',
            timeoutMs: 60_000,
            probeBytes: 64 * 1024,
            maxBytes: feed === 'M3U' ? M3U_MAX_FETCH_BYTES : XMLTV_MAX_FETCH_BYTES,
        });
    } catch {
        return m.livetv_admin_feed_unreachable({ feed });
    }
    const text = content.trim();
    if (feed === 'M3U') {
        return /^#EXTM3U(?:\s|$)/.test(text) ? undefined : m.livetv_admin_feed_invalid_m3u();
    }
    // Only the prefix is sampled; the import parser checks the complete records.
    const xml = text.replace(
        /^(?:<\?xml[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)+/i,
        '',
    );
    return /^<tv(?:\s[^<>]*?)?\s*\/?>/.test(xml) ? undefined : m.livetv_admin_feed_invalid_xmltv();
}
