/**
 * Turning a raw list into a taste profile.
 *
 * The thing an agent actually needs in order to recommend well is not 300
 * list entries — it is what those entries have in common, weighted by how the
 * user scored them. This is the aggregation that makes "what should I watch
 * next?" answerable in one tool call instead of a hundred.
 */
import type { MalListEntry } from "./clients/mal.js";

interface Tally {
  name: string;
  count: number;
  averageScore: number | null;
}

export interface TasteProfile {
  entriesConsidered: number;
  scoredEntries: number;
  averageScore: number | null;
  /** Genres the user rates highest, among those they have seen enough of to mean something. */
  favouriteGenres: Tally[];
  /** Genres they watch a lot of but rate below their own average — a real signal, and easy to miss. */
  overratedByHabit: Tally[];
  favouriteStudios: Tally[];
  byDecade: Tally[];
  byMediaType: Tally[];
  /** Their own words: tags and comments they wrote on entries they scored highly. */
  notesOnFavourites: Array<{ title: string; score: number; tags?: string[]; comment?: string }>;
}

function tally(
  entries: MalListEntry[],
  keysOf: (entry: MalListEntry) => string[],
  minCount: number,
): Tally[] {
  const buckets = new Map<string, { count: number; scoreSum: number; scored: number }>();

  for (const entry of entries) {
    const score = entry.list_status?.score ?? 0;
    for (const key of keysOf(entry)) {
      const bucket = buckets.get(key) ?? { count: 0, scoreSum: 0, scored: 0 };
      bucket.count += 1;
      if (score > 0) {
        bucket.scoreSum += score;
        bucket.scored += 1;
      }
      buckets.set(key, bucket);
    }
  }

  return [...buckets.entries()]
    .filter(([, bucket]) => bucket.count >= minCount)
    .map(([name, bucket]) => ({
      name,
      count: bucket.count,
      averageScore: bucket.scored > 0 ? Number((bucket.scoreSum / bucket.scored).toFixed(2)) : null,
    }));
}

const byScoreThenCount = (a: Tally, b: Tally): number =>
  (b.averageScore ?? 0) - (a.averageScore ?? 0) || b.count - a.count;

export function buildTasteProfile(entries: MalListEntry[]): TasteProfile {
  // Only finished and in-progress titles say anything about taste; a
  // plan-to-watch pile is a wishlist, not evidence.
  const watched = entries.filter((entry) => {
    const status = entry.list_status?.status;
    return status === "completed" || status === "watching" || status === "reading" || status === "rereading";
  });

  const scored = watched.filter((entry) => (entry.list_status?.score ?? 0) > 0);
  const averageScore =
    scored.length > 0
      ? Number((scored.reduce((sum, e) => sum + (e.list_status?.score ?? 0), 0) / scored.length).toFixed(2))
      : null;

  const genres = tally(watched, (e) => (e.node.genres ?? []).map((g) => g.name), 3);
  const studios = tally(watched, (e) => (e.node.studios ?? []).map((s) => s.name), 2);

  const decades = tally(
    watched,
    (e) => {
      const year = e.node.start_season?.year;
      return typeof year === "number" ? [`${Math.floor(year / 10) * 10}s`] : [];
    },
    1,
  );

  const mediaTypes = tally(watched, (e) => (e.node.media_type ? [e.node.media_type] : []), 1);

  const notesOnFavourites = scored
    .filter((entry) => {
      const status = entry.list_status;
      return (status?.score ?? 0) >= 8 && ((status?.tags?.length ?? 0) > 0 || Boolean(status?.comments));
    })
    .slice(0, 25)
    .map((entry) => ({
      title: entry.node.title,
      score: entry.list_status?.score ?? 0,
      tags: entry.list_status?.tags?.length ? entry.list_status.tags : undefined,
      comment: entry.list_status?.comments || undefined,
    }));

  return {
    entriesConsidered: watched.length,
    scoredEntries: scored.length,
    averageScore,
    favouriteGenres: [...genres].sort(byScoreThenCount).slice(0, 10),
    overratedByHabit:
      averageScore === null
        ? []
        : [...genres]
            .filter((g) => g.averageScore !== null && g.averageScore < averageScore && g.count >= 5)
            .sort((a, b) => b.count - a.count)
            .slice(0, 5),
    favouriteStudios: [...studios].sort(byScoreThenCount).slice(0, 10),
    byDecade: [...decades].sort((a, b) => b.count - a.count),
    byMediaType: [...mediaTypes].sort((a, b) => b.count - a.count),
    notesOnFavourites,
  };
}
