// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageLoad, PageServerData } from './$types';
import type EducationalShell from '$lib/components/viewing/EducationalShell.svelte';
import type PersonalShell from '$lib/components/viewing/PersonalShell.svelte';

type ViewingShellData = PageServerData & {
    educationalShell: typeof EducationalShell | null;
    personalShell: typeof PersonalShell | null;
};

/** Preserve SSR for specialized viewers without downloading them for movies/episodes. */
export const load = async ({ data }: Parameters<PageLoad>[0]): Promise<ViewingShellData> => {
    const kind = data.viewingContext?.kind;
    // The watch server response carries fresh availability; cached parent data
    // must not suppress a newly configured interface during SPA navigation.
    return {
        ...data,
        educationalShell:
            kind === 'educational' && data.viewingShellAvailable
                ? (await import('$lib/components/viewing/EducationalShell.svelte')).default
                : null,
        personalShell:
            kind === 'personal' && data.viewingShellAvailable
                ? (await import('$lib/components/viewing/PersonalShell.svelte')).default
                : null,
    };
};
