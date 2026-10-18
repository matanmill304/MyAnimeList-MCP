/**
 * The official MyAnimeList API v2, called with a user's OAuth token.
 *
 * Only this client touches personal data: the profile, the lists, and the
 * writes. Catalog browsing goes through clients/catalog.ts, which needs no
 * credentials at all.
 *
 * Reference: https://myanimelist.net/apiconfig/references/api/v2
 */
const API = "https://api.myanimelist.net/v2";

/**
 * List reads request node fields, not just list_status.
 *
 * This is deliberate and it is the difference between a list an agent can
 * reason about and one it cannot: with only `list_status`, every entry comes
 * back as id + title + picture, so building a taste profile would cost one
 * extra detail call per title. Asking for genres/season/mean up front makes
 * it a single request.
 */
const ANIME_NODE_FIELDS = "genres,media_type,num_episodes,mean,start_season,status,studios,rating";
const MANGA_NODE_FIELDS = "genres,media_type,num_chapters,num_volumes,mean,status,authors{first_name,last_name}";

const ANIME_LIST_STATUS =
  "list_status{status,score,num_episodes_watched,is_rewatching,updated_at,start_date,finish_date,priority,num_times_rewatched,rewatch_value,tags,comments}";
const MANGA_LIST_STATUS =
  "list_status{status,score,num_chapters_read,num_volumes_read,is_rereading,updated_at,start_date,finish_date,priority,num_times_reread,reread_value,tags,comments}";

export type Medium = "anime" | "manga";

export class MalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MalApiError";
  }
}

export interface MalNode {
  id: number;
  title: string;
  main_picture?: { medium?: string; large?: string };
  genres?: Array<{ id: number; name: string }>;
  media_type?: string;
  num_episodes?: number;
  num_chapters?: number;
  num_volumes?: number;
  mean?: number;
  status?: string;
  rating?: string;
  start_season?: { year: number; season: string };
  studios?: Array<{ id: number; name: string }>;
  authors?: Array<{ node?: { first_name?: string; last_name?: string }; role?: string }>;
}

export interface MalListStatus {
  status?: string;
  score?: number;
  num_episodes_watched?: number;
  num_chapters_read?: number;
  num_volumes_read?: number;
  is_rewatching?: boolean;
  is_rereading?: boolean;
  updated_at?: string;
  priority?: number;
  num_times_rewatched?: number;
  num_times_reread?: number;
  tags?: string[];
  comments?: string;
}

export interface MalListEntry {
  node: MalNode;
  list_status?: MalListStatus;
}

export class MalClient {
  constructor(private readonly accessToken: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(init.headers ?? {}),
      },
    });

    if (res.status === 401) {
      throw new MalApiError(
        "MyAnimeList rejected the access token. Disconnect and reconnect the connector to sign in again.",
        401,
      );
    }
    if (res.status === 404) {
      throw new MalApiError("MyAnimeList has no such entry.", 404);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { message?: string; error?: string };
        detail = body.message || body.error || "";
      } catch {
        /* a non-JSON error body is not worth surfacing */
      }
      throw new MalApiError(
        `MyAnimeList returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
        res.status,
      );
    }

    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  /**
   * The signed-in user's profile and anime watch statistics. Anime-only: the
   * API has no manga equivalent.
   *
   * MyAnimeList returns `birthday` whether or not it was asked for, so the
   * response is narrowed to the fields we actually requested. There is no
   * reason to hand a date of birth to a model that has no use for it.
   */
  async getMyProfile(): Promise<{
    id: number;
    name: string;
    location?: string;
    joined_at?: string;
    anime_statistics?: Record<string, number>;
  }> {
    const raw = await this.request<Record<string, unknown>>(
      "/users/@me?fields=id,name,location,joined_at,anime_statistics",
    );
    return {
      id: raw.id as number,
      name: raw.name as string,
      location: (raw.location as string) || undefined,
      joined_at: raw.joined_at as string | undefined,
      anime_statistics: raw.anime_statistics as Record<string, number> | undefined,
    };
  }

  /** A page of the signed-in user's own list, with enough node detail to reason about taste. */
  async getMyList(
    medium: Medium,
    options: { status?: string; sort?: string; limit?: number; offset?: number } = {},
  ): Promise<{ data: MalListEntry[]; hasMore: boolean }> {
    const params = new URLSearchParams({
      fields: medium === "anime" ? `${ANIME_LIST_STATUS},${ANIME_NODE_FIELDS}` : `${MANGA_LIST_STATUS},${MANGA_NODE_FIELDS}`,
      limit: String(options.limit ?? 100),
      offset: String(options.offset ?? 0),
      nsfw: "true", // the user's own list: show them what is actually on it
    });
    if (options.status) params.set("status", options.status);
    if (options.sort) params.set("sort", options.sort);

    const body = await this.request<{ data?: MalListEntry[]; paging?: { next?: string } }>(
      `/users/@me/${medium}list?${params}`,
    );
    return { data: body.data ?? [], hasMore: Boolean(body.paging?.next) };
  }

  /**
   * Every entry on the user's list, followed across pages.
   * Capped so one bad call cannot spend the whole request budget.
   */
  async getFullList(medium: Medium, status?: string, maxEntries = 1000): Promise<MalListEntry[]> {
    const all: MalListEntry[] = [];
    let offset = 0;
    while (all.length < maxEntries) {
      const page = await this.getMyList(medium, { status, limit: 1000, offset });
      all.push(...page.data);
      if (!page.hasMore || page.data.length === 0) break;
      offset += page.data.length;
    }
    return all.slice(0, maxEntries);
  }

  /**
   * MyAnimeList's own personalized suggestions for the signed-in user.
   * Returns an empty list for a brand-new account with no history.
   */
  async getSuggestions(limit = 20): Promise<MalNode[]> {
    const params = new URLSearchParams({
      limit: String(Math.min(limit, 100)),
      fields: `id,title,main_picture,synopsis,${ANIME_NODE_FIELDS}`,
    });
    const body = await this.request<{ data?: Array<{ node: MalNode }> }>(`/anime/suggestions?${params}`);
    return (body.data ?? []).map((item) => item.node);
  }

  /** Add or update one entry. MAL creates the entry if it is not on the list yet. */
  updateListEntry(
    medium: Medium,
    id: number,
    update: Record<string, string | number | boolean>,
  ): Promise<MalListStatus> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined && value !== null) body.set(key, String(value));
    }
    return this.request<MalListStatus>(`/${medium}/${id}/my_list_status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  /**
   * Remove one entry.
   *
   * The API documents a 404 when the entry was not on the list, but it has
   * been observed answering success either way, so a success here is not
   * proof that anything existed. Callers should say so rather than claim a
   * deletion they cannot verify.
   */
  async deleteListEntry(medium: Medium, id: number): Promise<void> {
    await this.request(`/${medium}/${id}/my_list_status`, { method: "DELETE" });
  }
}
