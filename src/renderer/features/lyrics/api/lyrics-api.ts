import { queryOptions } from '@tanstack/react-query';
import isElectron from 'is-electron';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { queryClient, QueryHookArgs } from '/@/renderer/lib/react-query';
import { getServerById, useSettingsStore } from '/@/renderer/store';
import { hasFeature } from '/@/shared/api/utils';
import {
    FullLyricsMetadata,
    InternetProviderLyricResponse,
    InternetProviderLyricSearchResponse,
    LyricGetQuery,
    LyricSearchQuery,
    LyricsOverride,
    LyricsQuery,
    QueueSong,
    Song,
    StructuredLyric,
    SynchronizedLyricsArray,
} from '/@/shared/types/domain-types';
import { LyricSource } from '/@/shared/types/domain-types';
import { LyricsResponse } from '/@/shared/types/domain-types';
import { ServerFeature } from '/@/shared/types/features-types';
import { isTTML, parseTTML } from '/@/main/features/core/lyrics/ttml'; // ← NEW

const lyricsIpc = isElectron() ? window.api.lyrics : null;

export type LyricsQueryResult = {
    local: FullLyricsMetadata | null | StructuredLyric[];
    overrideData: LyricsResponse | null;
    overrideSelection: LyricsOverride | null;
    remoteAuto: FullLyricsMetadata | null;
    selected: FullLyricsMetadata | null | StructuredLyric;
    selectedOffsetMs: number;
    selectedStructuredIndex: number;
    selectedSynced: boolean;
    suppressRemoteAuto: boolean;
};

// Match LRC lyrics format by https://github.com/ustbhuangyi/lyric-parser
// [mm:ss.SSS] text
const timeExp = /\[(\d{2,}):(\d{2})(?:\.(\d{2,3}))?]([^\n]+)(\n|$)/g;

// Match karaoke lyrics format returned by NetEase
// [SSS,???] text
const alternateTimeExp = /\[(\d*),(\d*)]([^\n]+)(\n|$)/g;

const formatLyrics = (lyrics: string): LyricsResponse => {
    // ── Apple TTML detection ─────────────────────────────────────────────────
    // Triggered when a FLAC file's LYRICS vorbis comment (or an M4A lyric atom)
    // contains raw Apple TTML XML. Navidrome passes it through unchanged as
    // song.lyrics; the structured-lyrics path (getLyricsBySongId) returns
    // pre-parsed JSON and never reaches this function.
    if (isTTML(lyrics)) {                           // ← NEW
        const parsed = parseTTML(lyrics);           // ← NEW
        if (parsed) return parsed;                  // ← NEW
        // parseTTML returned null → no timed <p> elements found;
        // fall through so the raw text is returned as unsynchronised lyrics.
    }

    // ── LRC (line-by-line) ───────────────────────────────────────────────────
    const synchronizedLines = lyrics.matchAll(timeExp);
    const formattedLyrics: SynchronizedLyricsArray = [];

    for (const line of synchronizedLines) {
        const [, minute, sec, ms, text] = line;
        const minutes = parseInt(minute, 10);
        const seconds = parseInt(sec, 10);
        const milis = ms?.length === 3 ? parseInt(ms, 10) : parseInt(ms, 10) * 10;

        const timeInMilis = (minutes * 60 + seconds) * 1000 + milis;

        formattedLyrics.push([timeInMilis, text]);
    }

    if (formattedLyrics.length > 0) return formattedLyrics;

    // ── NetEase karaoke format ───────────────────────────────────────────────
    const alternateSynchronizedLines = lyrics.matchAll(alternateTimeExp);
    for (const line of alternateSynchronizedLines) {
        const [, timeInMilis, , text] = line;
        const cleanText = text
            .replaceAll(/\(\d+,\d+\)/g, '')
            .replaceAll(/\s,/g, ',')
            .replaceAll(/\s\./g, '.');
        formattedLyrics.push([Number(timeInMilis), cleanText]);
    }

    if (formattedLyrics.length > 0) return formattedLyrics;

    // If no synchronized lyrics were found, return the original lyrics
    return lyrics;
};

export const formatLyricsForDisplay = formatLyrics;

export function computeSelectedFromResult(
    result: Pick<
        LyricsQueryResult,
        'local' | 'overrideData' | 'overrideSelection' | 'remoteAuto' | 'selectedOffsetMs'
    >,
    preferLocalLyrics: boolean,
    selectedStructuredIndex: number,
): {
    selected: FullLyricsMetadata | null | StructuredLyric;
    selectedSynced: boolean;
} {
    const { local, overrideData, overrideSelection, remoteAuto, selectedOffsetMs } = result;

    if (overrideSelection && overrideData) {
        const overrideLyrics: FullLyricsMetadata = {
            artist: overrideSelection.artist,
            lyrics: overrideData,
            name: overrideSelection.name,
            offsetMs: selectedOffsetMs,
            remote: overrideSelection.remote ?? true,
            source: overrideSelection.source,
        };
        return {
            selected: overrideLyrics,
            selectedSynced: Array.isArray(overrideData),
        };
    }

    const hasLocalLocal =
        (Array.isArray(local) && local.length > 0) ||
        (local != null && !Array.isArray(local) && 'lyrics' in local && Boolean(local.lyrics));

    if (preferLocalLyrics && hasLocalLocal) {
        if (Array.isArray(local) && local.length > 0) {
            const item = local[Math.min(selectedStructuredIndex, local.length - 1)];
            return { selected: item, selectedSynced: item.synced };
        }
        if (local != null && !Array.isArray(local) && 'lyrics' in local && local.lyrics) {
            return { selected: local, selectedSynced: Array.isArray(local.lyrics) };
        }
    }

    if (remoteAuto) {
        return {
            selected: remoteAuto,
            selectedSynced: Array.isArray(remoteAuto.lyrics),
        };
    }

    if (Array.isArray(local) && local.length > 0) {
        const item = local[Math.min(selectedStructuredIndex, local.length - 1)];
        return { selected: item, selectedSynced: item.synced };
    }

    if (local != null && !Array.isArray(local) && 'lyrics' in local && local.lyrics) {
        return { selected: local, selectedSynced: Array.isArray(local.lyrics) };
    }

    return { selected: null, selectedSynced: false };
}

export async function fetchLocalLyrics(params: {
    serverId: string;
    signal?: AbortSignal;
    song: QueueSong;
}): Promise<FullLyricsMetadata | null | StructuredLyric[]> {
    const { serverId, signal, song } = params;
    const server = getServerById(serverId);
    if (!server) throw new Error('Server not found');

    if (hasFeature(server, ServerFeature.LYRICS_MULTIPLE_STRUCTURED)) {
        // Navidrome / OpenSubsonic — returns pre-parsed StructuredLyric[] JSON
        // with millisecond timestamps. Raw TTML never appears on this path.
        const subsonicLyrics = await api.controller
            .getStructuredLyrics({
                apiClientProps: { serverId, signal },
                query: { songId: song.id },
            })
            .catch(console.error);
        if (subsonicLyrics?.length) return subsonicLyrics;
    } else if (hasFeature(server, ServerFeature.LYRICS_SINGLE_STRUCTURED)) {
        const jfLyrics = await api.controller
            .getLyrics({
                apiClientProps: { serverId, signal },
                query: { songId: song.id },
            })
            .catch((err) => console.error(err));
        if (jfLyrics) {
            return {
                artist: song.artists?.[0]?.name,
                lyrics: jfLyrics,
                name: song.name,
                remote: false,
                source: server?.name ?? 'music server',
            };
        }
    } else if (song.lyrics) {
        // Raw embedded tag from the audio file (FLAC LYRICS vorbis comment,
        // M4A lyric atom). May contain Apple TTML XML — formatLyrics() handles
        // detection and parsing before the LRC / plain-text fallback.
        return {
            artist: song.artists?.[0]?.name,
            lyrics: formatLyrics(song.lyrics),
            name: song.name,
            remote: false,
            source: server?.name ?? 'music server',
        };
    }
    return null;
}

export async function fetchRemoteLyricsAuto(song: QueueSong): Promise<FullLyricsMetadata | null> {
    const { fetch } = useSettingsStore.getState().lyrics;
    if (!fetch) return null;
    const remoteLyricsResult: InternetProviderLyricResponse | null =
        await lyricsIpc?.getRemoteLyricsBySong(song);

    if (remoteLyricsResult) {
        return {
            ...remoteLyricsResult,
            lyrics: formatLyrics(remoteLyricsResult.lyrics),
            remote: true,
        };
    }
    return null;
}

export async function fetchRemoteLyricsById(params: {
    remoteSongId: string;
    remoteSource: LyricSource;
    song?: QueueSong | Song;
}): Promise<LyricsResponse | null> {
    const result = await lyricsIpc?.getRemoteLyricsByRemoteId(params as LyricGetQuery);
    if (result) return formatLyrics(result);
    return null;
}

export function getDisplayOffset(
    selected: FullLyricsMetadata | null | StructuredLyric,
    storedOffsetMs: number,
    selectedStructuredIndex: number,
    local: FullLyricsMetadata | null | StructuredLyric[],
): number {
    if (selected && 'offsetMs' in selected && selected.offsetMs !== undefined) {
        return selected.offsetMs;
    }

    if (Array.isArray(local) && local.length > 0) {
        const item = local[Math.min(selectedStructuredIndex, local.length - 1)];
        return item.offsetMs ?? storedOffsetMs;
    }

    return storedOffsetMs;
}

const emptyResult = (): LyricsQueryResult => ({
    local: null,
    overrideData: null,
    overrideSelection: null,
    remoteAuto: null,
    selected: null,
    selectedOffsetMs: 0,
    selectedStructuredIndex: 0,
    selectedSynced: false,
    suppressRemoteAuto: false,
});

export const lyricsQueries = {
    search: (args: Omit<QueryHookArgs<LyricSearchQuery>, 'serverId'>) => {
        return queryOptions({
            gcTime: 1000 * 60 * 1,
            queryFn: () => {
                if (lyricsIpc) {
                    return lyricsIpc.searchRemoteLyrics(args.query);
                }
                return {} as Record<LyricSource, InternetProviderLyricSearchResponse[]>;
            },
            queryKey: queryKeys.songs.lyricsSearch(args.query),
            staleTime: 1000 * 60 * 1,
            ...args.options,
        });
    },
    songLyrics: (args: QueryHookArgs<LyricsQuery>, song: QueueSong | undefined) => {
        const lyricsKey = queryKeys.songs.lyrics(args.serverId, args.query);
        return queryOptions({
            gcTime: Infinity,
            queryFn: async ({ signal }): Promise<LyricsQueryResult> => {
                if (!song) return emptyResult();

                const prev = queryClient.getQueryData<LyricsQueryResult>(lyricsKey);
                const overrideSelection = prev?.overrideSelection ?? null;
                const suppressRemoteAuto = prev?.suppressRemoteAuto ?? false;
                const selectedStructuredIndex = prev?.selectedStructuredIndex ?? 0;
                const selectedOffsetMs = prev?.selectedOffsetMs ?? 0;
                const preferLocalLyrics = useSettingsStore.getState().lyrics.preferLocalLyrics;

                const localPromise = fetchLocalLyrics({ serverId: args.serverId, signal, song });

                const remoteAutoPromise =
                    suppressRemoteAuto || !useSettingsStore.getState().lyrics.fetch
                        ? null
                        : fetchRemoteLyricsAuto(song);

                const overrideDataPromise = overrideSelection
                    ? fetchRemoteLyricsById({
                          remoteSongId: overrideSelection.id,
                          remoteSource: overrideSelection.source as LyricSource,
                          song,
                      })
                    : null;

                const [local, remoteAuto, overrideData] = await Promise.all([
                    localPromise,
                    remoteAutoPromise,
                    overrideDataPromise,
                ]);

                const partial: Pick<
                    LyricsQueryResult,
                    | 'local'
                    | 'overrideData'
                    | 'overrideSelection'
                    | 'remoteAuto'
                    | 'selectedOffsetMs'
                > = {
                    local,
                    overrideData,
                    overrideSelection,
                    remoteAuto,
                    selectedOffsetMs,
                };
                const { selected, selectedSynced } = computeSelectedFromResult(
                    partial,
                    preferLocalLyrics,
                    selectedStructuredIndex,
                );
                const displayOffset = getDisplayOffset(
                    selected,
                    selectedOffsetMs,
                    selectedStructuredIndex,
                    local,
                );

                return {
                    ...emptyResult(),
                    ...partial,
                    selected,
                    selectedOffsetMs: displayOffset,
                    selectedStructuredIndex,
                    selectedSynced,
                    suppressRemoteAuto,
                };
            },
            queryKey: lyricsKey,
            staleTime: Infinity,
            ...args.options,
        });
    },
    songLyricsByRemoteId: (args: QueryHookArgs<Partial<LyricGetQuery>>) => {
        return queryOptions({
            gcTime: Infinity,
            queryFn: async () => {
                const q = args.query;
                if (!q?.remoteSongId || !q?.remoteSource) return null;
                return fetchRemoteLyricsById({
                    remoteSongId: q.remoteSongId,
                    remoteSource: q.remoteSource as LyricSource,
                    song: q.song as QueueSong | Song | undefined,
                });
            },
            queryKey: queryKeys.songs.lyricsByRemoteId(args.query),
            staleTime: Infinity,
            ...args.options,
        });
    },
};
