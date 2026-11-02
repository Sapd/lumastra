// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '$lib/server/config.js';
import { getRemoteLibrarySourceDescriptor } from '$lib/shared/remote-library-sources.js';

/** Keep explicit overrides; default filesystem libraries to the existing bare-code convention. */
export function resolveLibraryLanguage(
    language: string | null | undefined,
    provider = 'tmdb',
): string {
    return (
        language?.trim() ||
        (getRemoteLibrarySourceDescriptor(provider)
            ? ''
            : config.TMDB_LANGUAGE.trim().split('-')[0].toLowerCase())
    );
}
