// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Disk-full forecast line for the admin home library tile.
 *
 * Pure: takes the volumes of `/api/admin/library/storage-growth`, picks the one
 * that matters, and turns it into a short sentence plus a severity tone.
 * No false precision: weeks below ~8 weeks, whole months below 24 months,
 * whole years beyond, and "more than 10 years" past a decade.
 */

import * as m from '$lib/paraglide/messages.js';
import { formatBytes } from '$lib/utils/admin/formatters';
import type { LibraryVolumeGrowth } from '$lib/schemas/admin-library-storage-growth';

export type ForecastTone = 'neutral' | 'warning' | 'critical';

export interface StorageForecast {
    text: string;
    tone: ForecastTone;
    /** How precise the estimate is, e.g. "Low confidence · based on 20 days of measurements". */
    precision?: string;
    /** Tooltip; only set when more than one volume is measured. */
    title?: string;
}

const DAYS_PER_MONTH = 30.44;
const DAYS_PER_YEAR = 365.25;
/** Below this many days the figure is shown in weeks (~8 weeks). */
const WEEKS_BELOW_DAYS = 56;
/** Below this many months the figure is shown in months. */
const MONTHS_BELOW = 24;
const MAX_YEARS = 10;
const CRITICAL_BELOW_DAYS = 61;
const WARNING_BELOW_DAYS = 183;

type Unit = 'weeks' | 'months' | 'years';

function unitFor(days: number): Unit {
    if (days < WEEKS_BELOW_DAYS) return 'weeks';
    if (days / DAYS_PER_MONTH < MONTHS_BELOW) return 'months';
    return 'years';
}

function inUnit(days: number, unit: Unit): number {
    const divisor = unit === 'weeks' ? 7 : unit === 'months' ? DAYS_PER_MONTH : DAYS_PER_YEAR;
    return Math.max(1, Math.round(days / divisor));
}

function unitText(count: number, unit: Unit): string {
    if (unit === 'weeks') return m.admin_home_growth_unit_weeks({ count });
    if (unit === 'months') return m.admin_home_growth_unit_months({ count });
    return m.admin_home_growth_unit_years({ count });
}

function bandText(low: number, high: number | undefined, unit: Unit): string {
    if (high === undefined) {
        if (unit === 'weeks') return m.admin_home_growth_open_weeks({ low });
        if (unit === 'months') return m.admin_home_growth_open_months({ low });
        return m.admin_home_growth_open_years({ low });
    }
    if (unit === 'weeks') return m.admin_home_growth_range_weeks({ low, high });
    if (unit === 'months') return m.admin_home_growth_range_months({ low, high });
    return m.admin_home_growth_range_years({ low, high });
}

type Filling = Extract<LibraryVolumeGrowth['estimate'], { state: 'filling' }>;

/**
 * The volume to describe: the filling one that runs full first; otherwise a
 * volume still collecting data; otherwise a volume that is not filling.
 * `null` when no volume was measured.
 */
export function pickForecastVolume(
    volumes: readonly LibraryVolumeGrowth[],
): LibraryVolumeGrowth | null {
    if (volumes.length === 0) return null;
    let best: LibraryVolumeGrowth | null = null;
    for (const v of volumes) {
        if (v.estimate.state !== 'filling') continue;
        if (best === null || v.estimate.daysUntilFull < (best.estimate as Filling).daysUntilFull) {
            best = v;
        }
    }
    if (best) return best;
    return (
        volumes.find((v) => v.estimate.state === 'insufficient_data') ??
        volumes.find((v) => v.estimate.state === 'not_filling') ??
        null
    );
}

function fillingText(e: Filling): string {
    const days = Math.max(0, e.daysUntilFull);
    if (days < 7) return m.admin_home_growth_until_full_soon();
    if (days / DAYS_PER_YEAR > MAX_YEARS) return m.admin_home_growth_until_full_far();
    const unit = unitFor(days);
    const central = inUnit(days, unit);
    const value = unitText(central, unit);
    const low = inUnit(Math.min(e.daysUntilFullLow, days), unit);
    const high = e.daysUntilFullHigh === undefined ? undefined : inUnit(e.daysUntilFullHigh, unit);
    const differs = high === undefined ? true : low !== central || high !== central;
    if (!differs) return m.admin_home_growth_until_full({ value });
    return m.admin_home_growth_until_full_band({ value, band: bandText(low, high, unit) });
}

/**
 * The estimate's own account of how sure it is. Omitted for a server that
 * sends no confidence (older answers), so the line never claims more than
 * it was told.
 */
function precisionText(e: Filling): string | undefined {
    if (!e.confidence) return undefined;
    const parts = [
        e.confidence === 'low'
            ? m.admin_home_growth_precision_low()
            : e.confidence === 'medium'
              ? m.admin_home_growth_precision_medium()
              : m.admin_home_growth_precision_high(),
    ];
    if (e.basisDays !== undefined) parts.push(m.admin_home_growth_basis({ count: e.basisDays }));
    if (e.model === 'bursty') parts.push(m.admin_home_growth_model_bursty());
    if (e.model === 'seasonal') parts.push(m.admin_home_growth_model_seasonal());
    if (e.approximatePrior) parts.push(m.admin_home_growth_prior());
    if (e.ignoredDeletions)
        parts.push(m.admin_home_growth_ignored_deletions({ count: e.ignoredDeletions }));
    return parts.join(' · ');
}

function volumeTitle(volumes: readonly LibraryVolumeGrowth[]): string {
    return volumes
        .map((v) =>
            m.admin_home_growth_volume_line({
                libraries: v.libraries.length > 0 ? v.libraries.join(', ') : v.id,
                free: formatBytes(v.freeBytes),
                total: formatBytes(v.totalBytes),
            }),
        )
        .join('\n');
}

export function buildStorageForecast(
    volumes: readonly LibraryVolumeGrowth[],
): StorageForecast | null {
    const volume = pickForecastVolume(volumes);
    if (!volume) return null;
    const title = volumes.length > 1 ? volumeTitle(volumes) : undefined;
    const e = volume.estimate;
    let result: StorageForecast;
    if (e.state === 'filling') {
        const days = e.daysUntilFull;
        const tone: ForecastTone =
            days < CRITICAL_BELOW_DAYS
                ? 'critical'
                : days < WARNING_BELOW_DAYS
                  ? 'warning'
                  : 'neutral';
        result = { text: fillingText(e), tone };
        const precision = precisionText(e);
        if (precision) result.precision = precision;
    } else if (e.state === 'insufficient_data') {
        result = {
            text: m.admin_home_growth_insufficient({ days: e.snapshotDays }),
            tone: 'neutral',
        };
    } else {
        result = { text: m.admin_home_growth_not_filling(), tone: 'neutral' };
        // A big cleanup is the usual reason a disk "stopped filling"; say it
        // was left out of the pace rather than letting it look like the cause.
        if (e.ignoredDeletions) {
            result.precision = m.admin_home_growth_ignored_deletions({ count: e.ignoredDeletions });
        }
    }
    if (title !== undefined) result.title = title;
    return result;
}
