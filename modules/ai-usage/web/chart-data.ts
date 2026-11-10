import { loadChartData } from "./data.ts";

/**
 * The chart's daily rows for one period, for the page to ask for when the viewer changes the period without reloading
 * it. The shell only lets in someone who holds `ai_usage.read`, the permission of the pages. Query: `period` (7d, 30d, 90d,
 * all) and optionally `tool` (a tool's slug). An unknown value is answered with 400, never replaced by a default.
 */
export async function GET(request: Request): Promise<Response> {
  const result = await loadChartData(new URL(request.url).searchParams, new Date());
  if (!result.ok) return Response.json({ error: result.error }, { status: 400, headers: { "Cache-Control": "no-store" } });
  return Response.json(result.data, { headers: { "Cache-Control": "no-store" } });
}
