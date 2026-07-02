export async function researchWeb(query: string) {
  const trimmed = query.trim().slice(0, 240);
  if (!trimmed) {
    return { ok: false, tool: "research_web", error: "query_required" };
  }

  try {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Orvix/0.1 research tool"
      }
    });
    const html = await response.text();
    const results = parseSearchResults(html).slice(0, 5);
    return {
      ok: response.ok,
      tool: "research_web",
      query: trimmed,
      results,
      output: results.map((result, index) => `${index + 1}. ${result.title} ${result.url}\n${result.snippet}`).join("\n\n")
    };
  } catch (error) {
    return { ok: false, tool: "research_web", error: error instanceof Error ? error.message : "research_failed" };
  }
}

export async function fetchUrlForAgent(rawUrl: string) {
  const trimmed = rawUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, tool: "fetch_url", error: "http_url_required" };
  }

  try {
    const response = await fetch(trimmed, {
      headers: {
        "User-Agent": "Orvix/0.1 fetch_url tool"
      }
    });
    const text = await response.text();
    return {
      ok: response.ok,
      tool: "fetch_url",
      url: trimmed,
      status: response.status,
      output: stripHtml(text).slice(0, 6000)
    };
  } catch (error) {
    return { ok: false, tool: "fetch_url", error: error instanceof Error ? error.message : "fetch_failed" };
  }
}

export function parseSearchResults(html: string) {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = html.split(/result__body/gi).slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    if (!titleMatch) continue;
    const url = decodeHtml(titleMatch[1]).replace(/^\/l\/\?kh=-1&uddg=/, "");
    results.push({
      title: stripHtml(titleMatch[2]).slice(0, 160),
      url: decodeURIComponentSafe(url),
      snippet: stripHtml(snippetMatch?.[1] ?? snippetMatch?.[2] ?? "").slice(0, 260)
    });
  }
  return results;
}

export function stripHtml(input: string) {
  return decodeHtml(input)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeHtml(input: string) {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function decodeURIComponentSafe(input: string) {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

