// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

declare module '$env/dynamic/public' {
    export const env: {
        PUBLIC_AUDIOBOOKURL?: string;
        PUBLIC_AUTHURL?: string;
        PUBLIC_BOOKURL?: string;
        PUBLIC_GROUPS?: string;
        PUBLIC_JELLYFINURL?: string;
        PUBLIC_KAVITAURL?: string;
        PUBLIC_LOGOUTURL?: string;
        PUBLIC_REQUESTURL?: string;
    };
}
