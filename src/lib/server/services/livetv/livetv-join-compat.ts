// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The player's HEVC capability for a Live TV stream join (see StreamMultiplexer.compatVariantFor).
 */
import type { LiveTvClientHevc } from '../../../../shared/livetv-proxy-types.js';
import type { LiveTvJoinCompat } from './livetv-provider.js';

/**
 * The Lumastra iOS/tvOS app's URLSession requests (`lumastra-ios/<build> CFNetwork/… Darwin/…`;
 * older tvOS builds say `stellar-tvos`). Its own `Lumastra-iOS/1.0.1` header is set on other
 * calls only, so the default CFNetwork form is what identifies the stream join.
 */
const LUMASTRA_APPLE_APP_UA = /^(?:lumastra|stellar)-(?:ios|tvos)\/[^ ]+ CFNetwork\//i;

/**
 * A client that does not send `hevc` keeps the original stream, except the Lumastra Apple app:
 * its AVPlayer takes HEVC only from fMP4, and app builds from before the parameter existed
 * must not get an unplayable HEVC-in-MPEG-TS stream.
 */
export function liveTvJoinCompat(
    hevc: LiveTvClientHevc | undefined,
    userAgent: string | null,
): LiveTvJoinCompat | undefined {
    if (hevc) return { client: { hevc } };
    if (userAgent && LUMASTRA_APPLE_APP_UA.test(userAgent)) return { client: { hevc: 'fmp4' } };
    return undefined;
}
