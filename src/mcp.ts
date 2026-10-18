/**
 * The MCP endpoint.
 *
 * Stateless by design: each request builds a server, serves one JSON-RPC
 * message and goes away. That keeps the Worker on KV alone — no Durable
 * Objects, no session affinity, nothing to clean up.
 *
 * Every tool carries a `title` and a `readOnlyHint`/`destructiveHint`
 * annotation, which the Claude connector directory requires and which is
 * also how a client knows what it is allowed to do without asking.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env, Props } from "./env.js";
import { SCOPES } from "./env.js";
import { MalApiError, MalClient } from "./clients/mal.js";
import { CatalogClient, CatalogError } from "./clients/catalog.js";
import { buildTasteProfile } from "./taste.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const json = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const failure = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** Upstream faults become readable tool errors; real bugs still throw. */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MalApiError || error instanceof CatalogError) return failure(error.message);
    throw error;
  }
}

const SEASONS = ["winter", "spring", "summer", "fall"] as const;

function buildServer(props: Props, scopes: string[], env: Env): McpServer {
  const mal = new MalClient(props.malAccessToken);
  const catalog = new CatalogClient(env.CATALOG_BASE_URL);
  const canWrite = scopes.includes(SCOPES.write);

  const server = new McpServer(
    { name: "myanimelist", version: "0.1.0" },
    {
      instructions:
        "MyAnimeList for the signed-in user. To recommend something, start with " +
        "get_my_taste_profile (what they actually like, aggregated from their own scores) " +
        "and get_mal_suggestions (MyAnimeList's own personalized picks), then use " +
        "search_titles to filter candidates. Check get_my_list before suggesting a title, " +
        "so you never recommend something they have already seen.",
    },
  );

  // ---- personal data ------------------------------------------------------

  server.registerTool(
    "get_my_profile",
    {
      title: "Get my MyAnimeList profile",
      description:
        "The signed-in user's MyAnimeList profile and anime watch statistics (episodes watched, " +
        "days spent, mean score, counts per status). Anime only — MyAnimeList publishes no " +
        "equivalent statistics for manga.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => guard(async () => json(await mal.getMyProfile())),
  );

  server.registerTool(
    "get_my_taste_profile",
    {
      title: "Analyze my taste",
      description:
        "Aggregate the user's own list into a taste profile: which genres, studios, decades and " +
        "formats they rate highest, which they watch a lot of but rate below their own average, " +
        "and the notes they wrote on their favourites. Use this before recommending anything — " +
        "it answers 'what does this person actually like' in one call.",
      inputSchema: {
        medium: z.enum(["anime", "manga"]).default("anime").describe("Which list to analyze."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ medium }) =>
      guard(async () => json(buildTasteProfile(await mal.getFullList(medium ?? "anime")))),
  );

  server.registerTool(
    "get_my_list",
    {
      title: "Get my list",
      description:
        "The user's own anime or manga list, with each entry's status, score, progress and the " +
        "title's genres, format, season and community score. Filter by status to answer things " +
        "like 'what am I part-way through?'.",
      inputSchema: {
        medium: z.enum(["anime", "manga"]).default("anime"),
        status: z
          .enum(["watching", "reading", "completed", "on_hold", "dropped", "plan_to_watch", "plan_to_read"])
          .optional()
          .describe("Omit for the whole list. Use watching/plan_to_watch for anime, reading/plan_to_read for manga."),
        sort: z
          .enum(["list_score", "list_updated_at", "anime_title", "manga_title", "anime_start_date", "manga_start_date"])
          .optional()
          .describe("list_score and list_updated_at are highest/most-recent first."),
        limit: z.number().int().min(1).max(1000).default(100),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ medium, status, sort, limit, offset }) =>
      guard(async () => json(await mal.getMyList(medium ?? "anime", { status, sort, limit, offset }))),
  );

  server.registerTool(
    "get_mal_suggestions",
    {
      title: "Get MyAnimeList's suggestions for me",
      description:
        "MyAnimeList's own personalized anime suggestions for the signed-in user, derived from " +
        "their list by MyAnimeList itself. Returns nothing for a brand-new account with no " +
        "history. Complements get_my_taste_profile: this is MyAnimeList's opinion, that one is " +
        "the evidence.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ limit }) => guard(async () => json(await mal.getSuggestions(limit ?? 20))),
  );

  // ---- catalog ------------------------------------------------------------

  server.registerTool(
    "search_titles",
    {
      title: "Search anime and manga",
      description:
        "Search the catalogue with real filters: genre, format, airing status, score range, date " +
        "range and sort order, not just a text query. Use genre and score filters to build a " +
        "candidate list that matches a taste profile.",
      inputSchema: {
        medium: z.enum(["anime", "manga"]).default("anime"),
        q: z.string().optional().describe("Free-text title search. Optional when filtering."),
        genres: z.string().optional().describe("Comma-separated genre IDs to include, max 25."),
        genres_exclude: z.string().optional().describe("Comma-separated genre IDs to exclude."),
        type: z.string().optional().describe("Format, e.g. tv, movie, ova, special, ona for anime."),
        status: z.string().optional().describe("e.g. airing, complete, upcoming."),
        min_score: z.number().min(0).max(10).optional(),
        max_score: z.number().min(0).max(10).optional(),
        start_date: z.string().optional().describe("ISO date lower bound, e.g. 2023-01-01."),
        order_by: z.string().optional().describe("e.g. score, popularity, start_date, members."),
        sort: z.enum(["asc", "desc"]).optional(),
        sfw: z.boolean().default(true).describe("Exclude adult-rated results."),
        limit: z.number().int().min(1).max(25).default(15),
        page: z.number().int().min(1).max(1000).default(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      guard(async () =>
        json(
          await catalog.search(args.medium ?? "anime", {
            q: args.q,
            genres: args.genres,
            genresExclude: args.genres_exclude,
            type: args.type,
            status: args.status,
            minScore: args.min_score,
            maxScore: args.max_score,
            startDate: args.start_date,
            orderBy: args.order_by,
            sort: args.sort,
            sfw: args.sfw ?? true,
            limit: args.limit,
            page: args.page,
          }),
        ),
      ),
  );

  server.registerTool(
    "get_title_details",
    {
      title: "Get title details",
      description:
        "Full details for one anime or manga by its MyAnimeList ID: synopsis, score, genres, " +
        "studios, episode count, airing dates and rating.",
      inputSchema: {
        medium: z.enum(["anime", "manga"]).default("anime"),
        id: z.number().int().positive().describe("The MyAnimeList ID."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ medium, id }) => guard(async () => json(await catalog.details(medium ?? "anime", id))),
  );

  server.registerTool(
    "get_similar_titles",
    {
      title: "Find similar titles",
      description:
        "Titles that MyAnimeList users recommend to people who liked a given one. Good for " +
        "'more like this', and for expanding a shortlist around something the user rated highly.",
      inputSchema: {
        medium: z.enum(["anime", "manga"]).default("anime"),
        id: z.number().int().positive().describe("The MyAnimeList ID to find neighbours of."),
        limit: z.number().int().min(1).max(25).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ medium, id, limit }) =>
      guard(async () => json(await catalog.similarTo(medium ?? "anime", id, limit ?? 10))),
  );

  server.registerTool(
    "get_seasonal_anime",
    {
      title: "Get seasonal anime",
      description:
        "What is airing in a given season, or right now if year and season are omitted. " +
        "Seasons group as winter=Jan-Mar, spring=Apr-Jun, summer=Jul-Sep, fall=Oct-Dec.",
      inputSchema: {
        year: z.number().int().min(1917).max(2100).optional(),
        season: z.enum(SEASONS).optional(),
        sfw: z.boolean().default(true),
        limit: z.number().int().min(1).max(25).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ year, season, sfw, limit }) =>
      guard(async () =>
        json(
          year && season
            ? await catalog.season(year, season, limit ?? 20, sfw ?? true)
            : await catalog.currentSeason(limit ?? 20, sfw ?? true),
        ),
      ),
  );

  server.registerTool(
    "get_top_titles",
    {
      title: "Get top-ranked titles",
      description: "The highest-ranked anime or manga, optionally narrowed to a ranking bucket.",
      inputSchema: {
        medium: z.enum(["anime", "manga"]).default("anime"),
        filter: z
          .string()
          .optional()
          .describe("Ranking bucket, e.g. airing, upcoming, bypopularity, favorite."),
        limit: z.number().int().min(1).max(25).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ medium, filter, limit }) =>
      guard(async () => json(await catalog.top(medium ?? "anime", filter, limit ?? 20))),
  );

  // ---- writes -------------------------------------------------------------

  const needsWriteScope = (): ToolResult =>
    failure(
      "This connector is connected read-only. Reconnect it and allow the " +
        "'add titles and change progress' permission to make changes to your list.",
    );

  server.registerTool(
    "update_my_list_entry",
    {
      title: "Update my list entry",
      description:
        "Add a title to the user's list, or change an entry already on it: status, score, " +
        "episode or chapter progress, tags and comments. MyAnimeList creates the entry if it " +
        "is not there yet. Only the fields you pass are changed.",
      inputSchema: {
        medium: z.enum(["anime", "manga"]).default("anime"),
        id: z.number().int().positive().describe("The MyAnimeList ID of the title."),
        status: z
          .enum(["watching", "reading", "completed", "on_hold", "dropped", "plan_to_watch", "plan_to_read"])
          .optional(),
        score: z.number().int().min(0).max(10).optional().describe("0 clears the score."),
        num_watched_episodes: z.number().int().min(0).optional().describe("Anime only."),
        num_chapters_read: z.number().int().min(0).optional().describe("Manga only."),
        num_volumes_read: z.number().int().min(0).optional().describe("Manga only."),
        priority: z.number().int().min(0).max(2).optional().describe("0 low, 1 medium, 2 high."),
        tags: z.string().optional().describe("Comma-separated free-text tags."),
        comments: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ medium, id, ...fields }) =>
      guard(async () => {
        if (!canWrite) return needsWriteScope();
        const update = Object.fromEntries(
          Object.entries(fields).filter(([, value]) => value !== undefined),
        ) as Record<string, string | number | boolean>;
        if (Object.keys(update).length === 0) {
          return failure("Nothing to update: pass at least one field, such as status or score.");
        }
        return json(await mal.updateListEntry(medium ?? "anime", id, update));
      }),
  );

  server.registerTool(
    "remove_from_my_list",
    {
      title: "Remove from my list",
      description:
        "Delete a title from the user's list, discarding its status, score and progress. This " +
        "cannot be undone. MyAnimeList reports success whether or not the entry was there, so a " +
        "success does not prove anything was removed.",
      inputSchema: {
        medium: z.enum(["anime", "manga"]).default("anime"),
        id: z.number().int().positive().describe("The MyAnimeList ID of the title to remove."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ medium, id }) =>
      guard(async () => {
        if (!canWrite) return needsWriteScope();
        await mal.deleteListEntry(medium ?? "anime", id);
        return json({
          removed: true,
          note: "MyAnimeList accepted the deletion. It answers the same way for an entry that was never on the list.",
        });
      }),
  );

  return server;
}

/** What the OAuth provider adds to the execution context for an authorized request. */
interface ApiContext extends ExecutionContext {
  props: Props;
  auth: { scope: string[] };
}

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, baseCtx: ExecutionContext): Promise<Response> {
    const ctx = baseCtx as ApiContext;
    const server = buildServer(ctx.props, ctx.auth.scope, env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless: no session id, plain JSON responses instead of SSE.
      enableJsonResponse: true,
    });

    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      ctx.waitUntil(server.close());
    }
  },
};
