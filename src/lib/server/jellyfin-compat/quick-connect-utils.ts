// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export const QC_SECRET_PREFIX = 'jfcompat:qc:secret:';
export const QC_CODE_PREFIX = 'jfcompat:qc:code:';
export const QC_TTL_SECONDS = 5 * 60; // 5 minutes

export interface QuickConnectData {
    approvedBySessionToken?: string;
    code: string;
    authenticated: boolean;
    userId: string | null;
    username: string | null;
    isAdmin: boolean;
    groups: string[];
    displayName: string | null;
}
