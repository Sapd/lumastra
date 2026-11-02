// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Surface-correct channel logo URLs.
 *
 * The LiveTV provider stores logos as the BFF path
 * `/api/image/catalog/{channelId}/poster?size=thumb` (see
 * standalone-livetv-provider's `proxyLogoUrl`). That path shape exists ONLY on
 * the internal/BFF surface and is cookie-authenticated, so it is unusable by
 * native clients.
 *
 * Rewriting just the `/api/image` prefix to a per-mount `imageBase` (what the channel
 * defs used to do) produced `/api/v1/image/catalog/...` — a route that does not
 * exist at all since commit 6dee55dc5 deleted the whole `/api/v1/image/**`
 * proxy tree. Every v1 client therefore 404'd on every channel logo.
 *
 * The canonical image path on BOTH surfaces is the entity route
 * `{apiBase(surface)}/media/{id}/images/{role}` — `/api/media/...`
 * internally and `/api/v1/media/...` on v1. It is mounted from a single def
 * (`defs/media/[id]/images/[role]`), is `auth: 'public'`, and resolves through
 * the same `imageProxyService.getImageByCatalogId()` that serves the BFF path —
 * including the `tvchannel` branch that proxies `custom_poster_url` (the M3U
 * `tvg-logo`) upstream for IP hiding.
 *
 * Building the URL from the channel ID rather than string-patching the stored
 * URL keeps the two surfaces in lockstep and removes the prefix-replace
 * coupling to whatever shape the provider happens to emit.
 */

export { channelImageSet } from '$lib/server/services/image-descriptor/resources.js';
