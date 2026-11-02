// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Holiday Plugin
 */

import { describe, it, expect } from 'vitest';
import { getCurrentHoliday, getAllHolidays, getHolidayById } from '$lib/server/plugins/holidays';

describe('Holiday Detector', () => {
    describe('getCurrentHoliday', () => {
        describe('Christmas detection', () => {
            it('detects Christmas on December 25th', () => {
                const holiday = getCurrentHoliday(new Date('2024-12-25'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('christmas');
                expect(holiday?.name).toBe('Christmas');
            });

            it('detects Christmas on December 26th', () => {
                const holiday = getCurrentHoliday(new Date('2024-12-26'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('christmas');
            });

            it('detects pre-Christmas (Advent) on December 1st', () => {
                const holiday = getCurrentHoliday(new Date('2024-12-01'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('christmas');
                // During Advent, should have pre-holiday name
                expect(holiday?.localizedNames?.de).toBe('Schon in Weihnachtsstimmung?');
                expect(holiday?.emoji).toBe('🕯️');
            });

            it('detects Christmas on December 23rd (main period, not pre-holiday)', () => {
                const holiday = getCurrentHoliday(new Date('2024-12-23'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('christmas');
                expect(holiday?.localizedNames?.de).toBe('Weihnachten');
                expect(holiday?.emoji).toBe('🎄');
            });

            it('detects Christmas starting November 20th', () => {
                const holiday = getCurrentHoliday(new Date('2024-11-20'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('christmas');
            });
        });

        describe('Halloween detection', () => {
            it('detects Halloween on October 31st', () => {
                const holiday = getCurrentHoliday(new Date('2024-10-31'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('halloween');
                expect(holiday?.emoji).toBe('🎃');
            });

            it('detects Halloween on October 20th', () => {
                const holiday = getCurrentHoliday(new Date('2024-10-20'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('halloween');
            });

            it('detects Halloween extends into November 3rd', () => {
                const holiday = getCurrentHoliday(new Date('2024-11-02'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('halloween');
            });
        });

        describe("New Year's detection (year-wrapping)", () => {
            it("detects New Year's on December 31st", () => {
                const holiday = getCurrentHoliday(new Date('2024-12-31'));
                expect(holiday).not.toBeNull();
                // Could be New Year's or Christmas depending on priority
                expect(['newyear', 'christmas']).toContain(holiday?.id);
            });

            it("detects New Year's on January 1st", () => {
                const holiday = getCurrentHoliday(new Date('2025-01-01'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('newyear');
            });

            it("detects New Year's on January 5th", () => {
                const holiday = getCurrentHoliday(new Date('2025-01-05'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('newyear');
            });
        });

        describe("Valentine's Day detection", () => {
            it("detects Valentine's Day on February 14th", () => {
                const holiday = getCurrentHoliday(new Date('2024-02-14'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('valentines');
                expect(holiday?.emoji).toBe('❤️');
            });

            it("detects Valentine's period starting February 1st", () => {
                const holiday = getCurrentHoliday(new Date('2024-02-01'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('valentines');
            });
        });

        describe('Easter detection', () => {
            it('detects Easter in April', () => {
                const holiday = getCurrentHoliday(new Date('2024-04-01'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('easter');
                expect(holiday?.emoji).toBe('🐰');
            });
        });

        describe('German holidays', () => {
            it('detects German Unity Day on October 3rd', () => {
                const holiday = getCurrentHoliday(new Date('2024-10-03'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('german-unity');
                expect(holiday?.localizedNames?.de).toBe('Tag der Deutschen Einheit');
            });

            it('detects Oktoberfest in September', () => {
                const holiday = getCurrentHoliday(new Date('2024-09-18'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('oktoberfest');
                expect(holiday?.emoji).toBe('🍺');
            });

            it('detects Karneval vs Valentines overlap', () => {
                // Feb 12 is in both Valentine's (Feb 1-14) and Karneval (Feb 10-14)
                // Valentine's comes first in the array, so it takes priority
                const holiday = getCurrentHoliday(new Date('2024-02-12'));
                expect(holiday).not.toBeNull();
                // Due to array order, Valentine's is detected first
                expect(holiday?.id).toBe('valentines');
            });
        });

        describe('Europe Day detection', () => {
            it('detects Europe Day on May 9th', () => {
                const holiday = getCurrentHoliday(new Date('2024-05-09'));
                expect(holiday).not.toBeNull();
                expect(holiday?.id).toBe('europe-day');
                expect(holiday?.emoji).toBe('🇪🇺');
            });
        });

        describe('no holiday periods', () => {
            it('returns null in mid-June', () => {
                const holiday = getCurrentHoliday(new Date('2024-06-15'));
                expect(holiday).toBeNull();
            });

            it('returns null in mid-July', () => {
                const holiday = getCurrentHoliday(new Date('2024-07-15'));
                expect(holiday).toBeNull();
            });

            it('returns null in mid-August', () => {
                const holiday = getCurrentHoliday(new Date('2024-08-15'));
                expect(holiday).toBeNull();
            });
        });

        describe('edge cases', () => {
            it('handles default date (current date)', () => {
                // Should not throw, may return null or a holiday
                expect(() => getCurrentHoliday()).not.toThrow();
            });
        });
    });

    describe('getAllHolidays', () => {
        it('returns an array of holidays', () => {
            const holidays = getAllHolidays();
            expect(Array.isArray(holidays)).toBe(true);
            expect(holidays.length).toBeGreaterThan(0);
        });

        it('each holiday has required properties', () => {
            const holidays = getAllHolidays();
            holidays.forEach((holiday) => {
                expect(holiday).toHaveProperty('id');
                expect(holiday).toHaveProperty('name');
                expect(holiday).toHaveProperty('emoji');
                expect(holiday).toHaveProperty('startMonth');
                expect(holiday).toHaveProperty('startDay');
                expect(holiday).toHaveProperty('endMonth');
                expect(holiday).toHaveProperty('endDay');
                expect(holiday).toHaveProperty('sources');
                expect(holiday).toHaveProperty('backgroundColor');
                expect(holiday).toHaveProperty('textColor');
                // localizedNames is optional
            });
        });

        it('includes expected holidays', () => {
            const holidays = getAllHolidays();
            const ids = holidays.map((h) => h.id);

            expect(ids).toContain('christmas');
            expect(ids).toContain('halloween');
            expect(ids).toContain('newyear');
            expect(ids).toContain('valentines');
            expect(ids).toContain('easter');
        });

        it('all date ranges are valid', () => {
            const holidays = getAllHolidays();
            holidays.forEach((holiday) => {
                expect(holiday.startMonth).toBeGreaterThanOrEqual(1);
                expect(holiday.startMonth).toBeLessThanOrEqual(12);
                expect(holiday.endMonth).toBeGreaterThanOrEqual(1);
                expect(holiday.endMonth).toBeLessThanOrEqual(12);
                expect(holiday.startDay).toBeGreaterThanOrEqual(1);
                expect(holiday.startDay).toBeLessThanOrEqual(31);
                expect(holiday.endDay).toBeGreaterThanOrEqual(1);
                expect(holiday.endDay).toBeLessThanOrEqual(31);
            });
        });
    });

    describe('getHolidayById', () => {
        it('returns holiday for valid ID', () => {
            const christmas = getHolidayById('christmas');
            expect(christmas).not.toBeNull();
            expect(christmas?.name).toBe('Christmas');
        });

        it('returns halloween for valid ID', () => {
            const halloween = getHolidayById('halloween');
            expect(halloween).not.toBeNull();
            expect(halloween?.emoji).toBe('🎃');
        });

        it('returns null for unknown ID', () => {
            expect(getHolidayById('unknown-holiday')).toBeNull();
            expect(getHolidayById('')).toBeNull();
        });

        it('all holidays can be retrieved by ID', () => {
            const allHolidays = getAllHolidays();
            allHolidays.forEach((holiday) => {
                const retrieved = getHolidayById(holiday.id);
                expect(retrieved).not.toBeNull();
                expect(retrieved?.id).toBe(holiday.id);
            });
        });
    });

    describe('holiday metadata', () => {
        it('Christmas has TMDB sources with keyword IDs', () => {
            const christmas = getHolidayById('christmas');
            expect(christmas?.sources).toBeDefined();
            expect(christmas?.sources?.length).toBeGreaterThan(0);
            // Check that at least one TMDB source has keyword IDs
            const tmdbSource = christmas?.sources?.find((s) => s.type === 'tmdb');
            expect(tmdbSource).toBeDefined();
            if (tmdbSource?.type === 'tmdb') {
                expect(tmdbSource.keywordIds?.length).toBeGreaterThan(0);
            }
        });

        it('Christmas has TMDB sources with collection IDs', () => {
            const christmas = getHolidayById('christmas');
            const tmdbSource = christmas?.sources?.find((s) => s.type === 'tmdb');
            expect(tmdbSource).toBeDefined();
            if (tmdbSource?.type === 'tmdb') {
                expect(tmdbSource.collectionIds?.length).toBeGreaterThan(0);
            }
        });

        it('holidays have content sources', () => {
            const allHolidays = getAllHolidays();
            allHolidays.forEach((holiday) => {
                expect(Array.isArray(holiday.sources)).toBe(true);
                expect(holiday.sources.length).toBeGreaterThan(0);
            });
        });

        it('all sources have valid type', () => {
            const allHolidays = getAllHolidays();
            allHolidays.forEach((holiday) => {
                holiday.sources.forEach((source) => {
                    expect(['tmdb', 'mdblist', 'custom']).toContain(source.type);
                });
            });
        });
    });

    describe('pre-holiday variants', () => {
        it('Christmas has pre-holiday configuration', () => {
            const christmas = getHolidayById('christmas');
            expect(christmas?.preHoliday).toBeDefined();
            expect(christmas?.preHoliday?.localizedNames?.de).toBe('Schon in Weihnachtsstimmung?');
        });

        it('pre-holiday period is before main holiday', () => {
            const christmas = getHolidayById('christmas');
            const preHoliday = christmas?.preHoliday;

            if (preHoliday) {
                // Pre-holiday should end before or when main holiday really starts
                expect(preHoliday.endMonth).toBe(12);
                expect(preHoliday.endDay).toBeLessThanOrEqual(christmas.endDay);
            }
        });
    });
});
