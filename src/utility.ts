// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export function convertBitrate(bitrate: number) {
    if (!bitrate) {
        return 'N/A';
    }
    const kbps = (bitrate / 1000).toFixed(1);
    const mbps = (bitrate / 1000000).toFixed(1);

    if (bitrate > 1000) {
        return mbps + ' Mbps';
    } else {
        return kbps + ' Kbps';
    }
}

export function shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]]; // Swap elements
    }
    return array;
}

export function convertSecondsToHoursAndMinutes(seconds: number): string {
    const hours: number = Math.floor(seconds / 3600);
    const minutes: number = Math.floor((seconds % 3600) / 60);

    if (hours) return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
    else return `${minutes.toString().padStart(2, '0')}m`;
}

export function youtube_parser(url: string): string | false {
    const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    return match && match[7].length == 11 ? match[7] : false;
}
