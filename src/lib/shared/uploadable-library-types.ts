// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Non-entertainment library types that accept uploads. Shared so the admin
 * Sources page can tell, client-side, when an edit changes whether the Library
 * → Upload tab applies (see the admin layout's `libraryUpload` feature).
 */
export const UPLOADABLE_LIBRARY_TYPES: ReadonlySet<string> = new Set([
    'home_video',
    'training',
    'educational',
    'personal',
]);

/** `depends()` key for the admin layout's `libraryUpload` nav gate. */
export const LIBRARY_UPLOAD_NAV_DEP = 'app:admin-library-upload';
