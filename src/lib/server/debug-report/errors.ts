// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** No report may leave the builder without the configuration secret sweep list. */
export class DebugReportConfigurationError extends Error {
    constructor() {
        super('Configuration not loaded');
        this.name = 'DebugReportConfigurationError';
    }
}
