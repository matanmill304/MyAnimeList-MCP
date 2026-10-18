/**
 * Catalog reads — search, details, seasons, rankings, similar titles.
 *
 * These go to a MyAnimeList mirror rather than the official API, for one
 * concrete reason: the official search takes `q` and nothing else. No genre,
 * year, studio, status or score filter exists anywhere in the official v2
 * surface, which makes "an upbeat 12-episode comedy from the last two years"
 * unanswerable. The mirror exposes those filters over the same catalogue.
 *
 * The base URL is configuration (CATALOG_BASE_URL), not a constant, so the
 * mirror can be swapped without touching call sites. The response shape here
 * is the Jikan-compatible one that both Tenrai and Jikan serve.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

export interface CatalogEntry {
  mal_id: number;
  title: string;
  title_english?: string | null;
  type?: string | null;
  episodes?: number | null;
  chapters?: number | null;
  status?: string | null;
  score?: number | null;
  scored_by?: number | null;
  rank?: number | null;
  members?: number | null;
  year?: number | null;
  season?: string | null;
  rating?: string | null;
  synopsis?: string | null;
  genres?: Array<{ mal_id: number; name: string }>;
  themes?: Array<{ mal_id: number; name: string }>;
  demographics?: Array<{ mal_id: number; name: string }>;
  studios?: Array<{ mal_id: number; name: string }>;
  url?: string;
}

export interface SearchOptions {
  q?: string;
  genres?: string;
  genresExclude?: string;
  type?: string;
  status?: string;
  minScore?: number;
  maxScore?: number;
  startDate?: string;
  endDate?: string;
  orderBy?: string;
  sort?: "asc" | "desc";
  sfw?: boolean;
  limit?: number;
  page?: number;
}

export class CatalogClient {
  constructor(private readonly baseUrl: string) {}

  private async get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
      throw new CatalogError(`The anime catalogue ${reason}. Try again in a moment.`, 503);
    }

    if (res.status === 404) throw new CatalogError("No such title in the catalogue.", 404);
    if (res.status === 429) throw new CatalogError("The catalogue is rate limiting us. Try again shortly.", 429);
    if (!res.ok) throw new CatalogError(`The catalogue returned HTTP ${res.status}.`, res.status);

    return (await res.json()) as T;
  }

  async search(medium: "anime" | "manga", options: SearchOptions): Promise<CatalogEntry[]> {
    const body = await this.get<{ data?: CatalogEntry[] }>(`/${medium}`, {
      q: options.q,
      genres: options.genres,
      genres_exclude: options.genresExclude,
      type: options.type,
      status: options.status,
      min_score: options.minScore,
      max_score: options.maxScore,
      start_date: options.startDate,
      end_date: options.endDate,
      order_by: options.orderBy,
      sort: options.sort,
      sfw: options.sfw === true ? "true" : undefined,
      limit: options.limit ?? 15,
      page: options.page ?? 1,
    });
    return body.data ?? [];
  }

  async details(medium: "anime" | "manga", id: number): Promise<CatalogEntry> {
    const body = await this.get<{ data?: CatalogEntry }>(`/${medium}/${id}`);
    if (!body.data) throw new CatalogError("No such title in the catalogue.", 404);
    return body.data;
  }

  async season(year: number, season: string, limit: number, sfw: boolean): Promise<CatalogEntry[]> {
    const body = await this.get<{ data?: CatalogEntry[] }>(`/seasons/${year}/${season}`, {
      limit,
      sfw: sfw ? "true" : undefined,
    });
    return body.data ?? [];
  }

  async currentSeason(limit: number, sfw: boolean): Promise<CatalogEntry[]> {
    const body = await this.get<{ data?: CatalogEntry[] }>("/seasons/now", {
      limit,
      sfw: sfw ? "true" : undefined,
    });
    return body.data ?? [];
  }

  async top(medium: "anime" | "manga", filter: string | undefined, limit: number): Promise<CatalogEntry[]> {
    const body = await this.get<{ data?: CatalogEntry[] }>(`/top/${medium}`, { filter, limit });
    return body.data ?? [];
  }

  /** Titles other users recommend to people who liked this one. */
  async similarTo(medium: "anime" | "manga", id: number, limit: number): Promise<CatalogEntry[]> {
    const body = await this.get<{ data?: Array<{ entry?: CatalogEntry; votes?: number }> }>(
      `/${medium}/${id}/recommendations`,
    );
    return (body.data ?? [])
      .map((item) => item.entry)
      .filter((entry): entry is CatalogEntry => Boolean(entry))
      .slice(0, limit);
  }
}
