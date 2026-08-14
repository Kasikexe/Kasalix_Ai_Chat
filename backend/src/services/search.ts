import { streamChat } from './ollama';
import { getModelAssignment } from './model-assignments';
import type { Message } from '../types';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Real browser User-Agent to avoid being blocked */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Minimum delay between searches (ms) to avoid rate limiting */
const MIN_DELAY_MS = 1500;
let lastSearchTime = 0;

/** Clean HTML entities from a string */
function cleanEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * Check if a line of text looks like real content vs navigation/boilerplate.
 */
function isUsefulLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 25) return false; // Skip very short nav links/labels

  // Skip common boilerplate
  const lower = trimmed.toLowerCase();
  const boilerplate = [
    'cookie', 'privacy policy', 'terms of service', 'terms and conditions',
    'all rights reserved', 'copyright', '©', 'subscribe', 'newsletter',
    'advertisement', 'sponsored', 'sign up', 'log in', 'sign in',
    'create account', 'forgot password', 'share this', 'tweet', 'facebook',
    'click here', 'read more', 'related articles', 'you might also like',
    'your browser', 'enable javascript', 'skip to', 'menu', 'navigation',
  ];
  if (boilerplate.some((b) => lower.includes(b))) return false;

  // Must have some alphabetic content (not just numbers/symbols)
  const alphaCount = (trimmed.match(/[a-zA-Z]/g) || []).length;
  if (alphaCount < 10) return false;

  return true;
}

/**
 * Fetch a page URL and extract its readable text content.
 * Only extracts text from <p>, <h1-6>, and <li> tags — real article content.
 */
async function fetchPageContent(url: string, maxChars: number = 4000): Promise<string | null> {
  // Skip binary/content URLs that won't contain readable text
  const skipExtensions = ['.pdf', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.mp4', '.mp3', '.doc', '.docx'];
  const urlLower = url.toLowerCase();
  if (skipExtensions.some((ext) => urlLower.includes(ext))) return null;

  // Only fetch http/https URLs
  if (!url.startsWith('http://') && !url.startsWith('https://')) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
      },
    });

    clearTimeout(timeout);

    if (!res.ok) return null;

    // Early size check via Content-Length header before loading body
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 500000) return null; // Skip >500KB

    let html = await res.text();
    if (html.length > 200000) return null;

    // Remove script and style blocks FIRST
    html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
    html = html.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, ' ');

    // Try to focus on main/article content areas
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const scope = articleMatch?.[1] || mainMatch?.[1] || bodyMatch?.[1] || html;

    // Extract text ONLY from paragraph and heading tags (this is where article content lives)
    const contentTags = scope.matchAll(/<(p|h[1-6]|li)[^>]*>([\s\S]*?)<\/\1>/gi);
    const lines: string[] = [];

    for (const match of contentTags) {
      // Strip any inner HTML tags
      let text = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      text = cleanEntities(text);
      if (isUsefulLine(text)) {
        lines.push(text);
      }
    }

    // Deduplicate: skip lines that are very similar to the previous one
    const unique: string[] = [];
    for (const line of lines) {
      const prev = unique[unique.length - 1];
      if (prev && line.length > 20 && prev.includes(line.substring(0, 20))) {
        continue; // This line is mostly contained in previous
      }
      unique.push(line);
    }

    let result = unique.join('\n\n');

    // HYBRID FALLBACK: If semantic tag extraction yielded little content (<500 chars),
    // fall back to body-level text with filtering. This catches data in <div>/<span>
    // layouts (like weather sites, Wikipedia tables) that don't use <p>/<h>/<li> tags.
    if (result.length < 500) {
      // Use a unique placeholder (won't appear in text) to preserve element boundaries
      // through the whitespace-collapsing step below
      const BOUNDARY = ' ||| ';
      let prepped = scope
        .replace(/<\/(div|p|section|article|li|td|th|tr|span|h[1-6])>/gi, BOUNDARY)
        .replace(/<(br|hr)[^>]*>/gi, BOUNDARY);

      // Strip all remaining HTML tags
      const stripped = prepped
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const rawText = cleanEntities(stripped);

      // Split by boundary placeholder and filter
      const rawLines = rawText
        .split(BOUNDARY)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const filteredLines = rawLines.filter(isUsefulLine);

      // Deduplicate
      const rawUnique: string[] = [];
      for (const line of filteredLines) {
        const prev = rawUnique[rawUnique.length - 1];
        if (prev && line.length > 20 && prev.includes(line.substring(0, 20))) {
          continue;
        }
        rawUnique.push(line);
      }

      const fallbackResult = rawUnique.join('\n');
      if (fallbackResult.length > result.length) {
        result = fallbackResult;
        console.log(`[search] Used body fallback for ${url.substring(0, 60)} (${result.length} chars)`);
      }
    }

    if (result.length <= 100) return null;
    return result.substring(0, maxChars);
  } catch (e) {
    return null;
  }
}

/**
 * Search DuckDuckGo via the HTML endpoint (same as a normal browser).
 */
async function duckSearch(query: string, maxResults: number = 5): Promise<SearchResult[]> {
  // Rate limiting: ensure at least MIN_DELAY_MS between searches
  const now = Date.now();
  const elapsed = now - lastSearchTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  lastSearchTime = Date.now();

  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://html.duckduckgo.com',
        'Referer': 'https://html.duckduckgo.com/',
      },
      body: new URLSearchParams({ q: query }),
    });

    if (!res.ok) {
      console.error(`[search] DuckDuckGo returned ${res.status}`);
      return [];
    }

    const html = await res.text();

    // Parse results from DuckDuckGo HTML
    const results: SearchResult[] = [];
    const resultBlocks = html.split('<div class="result results_links results_links_deep web-result ">');

    for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
      const block = resultBlocks[i];

      // Extract URL from the anchor tag
      const urlMatch = block.match(/<a[^>]+rel="nofollow"[^>]+class="result__a"[^>]+href="([^"]+)"/);
      const url = urlMatch ? urlMatch[1] : '';

      // Extract title from the same anchor tag (text between > and </a>)
      const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      let title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      // Extract snippet from the snippet link
      const snippetMatch = block.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      let snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      title = cleanEntities(title);
      snippet = cleanEntities(snippet);

      if (title || url) {
        results.push({ title, url, snippet });
      }
    }

    return results;
  } catch (e) {
    console.error('[search] DuckDuckGo search failed:', e);
    return [];
  }
}

/**
 * Search the web and return AI-summarized context with actual page content.
 * 1. Searches DuckDuckGo
 * 2. Fetches actual content from top result pages
 * 3. Uses AI to summarize everything into useful context
 */
export async function getWebContext(query: string): Promise<string | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  console.log(`[search] Searching for: "${trimmed}"`);

  // Step 1: Get raw results from DuckDuckGo
  const results = await duckSearch(trimmed);
  if (results.length === 0) return null;

  console.log(`[search] DuckDuckGo returned ${results.length} results`);

  // Step 2: Fetch actual content from top result pages (in PARALLEL for speed)
  const topUrls = results.slice(0, 2);
  const pageResults = await Promise.all(
    topUrls.map(async (result) => {
      const content = await fetchPageContent(result.url);
      return { url: result.url, content };
    })
  );

  const fetchedContentCount = pageResults.filter((p) => p.content !== null).length;
  console.log(`[search] Fetched ${fetchedContentCount}/${topUrls.length} pages successfully`);
  if (fetchedContentCount > 0) {
    for (const pr of pageResults) {
      if (pr.content) {
        console.log(`[search]   ${pr.url.substring(0, 80)} (${pr.content.length} chars)`);
      }
    }
  }

  // Step 3: Build a comprehensive context from both snippets and page content
  const contextParts: string[] = ['## Search Result Snippets\n'];
  for (const r of results) {
    contextParts.push(`**${r.title}**\nURL: ${r.url}\n${r.snippet}`);
  }

  for (const pc of pageResults) {
    if (pc.content) {
      contextParts.push(`\n## Page Content from: ${pc.url}\n${pc.content}`);
    }
  }

  const fullContext = contextParts.join('\n\n');

  // Step 4: Use the search assignment model to summarize everything
  const searchModel = await getModelAssignment('search');
  const summarizePrompt = `You are a precise web search summarizer. Your job is to extract and report ONLY facts that are EXPLICITLY stated in the text below.

User's question: "${trimmed}"

Information gathered from web search:
${fullContext}

CRITICAL RULES:
- ONLY report facts, numbers, and data that are DIRECTLY stated in the text above
- DO NOT guess, estimate, or fill in missing numbers
- DO NOT use your own knowledge to add data not in the text
- If a number appears in the text, report it exactly as stated
- If the text does not contain the requested data, say "The search results do not contain this specific information"
- Include ALL specific factual data found: temperatures, prices, statistics, names, dates, etc.
- Keep it under 500 words but include every specific fact you find`;

  const messages: Message[] = [{ role: 'system', content: summarizePrompt }];

  let summary = '';
  try {
    await streamChat(
      searchModel,
      messages,
      (chunk) => { summary += chunk; },
      { think: false }
    );
  } catch (e) {
    console.error('[search] Summarization failed, using raw content:', e);
    // Fall back to raw content if AI summarization fails
    return `Recent web search results for "${trimmed}":\n\n${fullContext}`;
  }

  // A safety-tuned search model (e.g. llama3.2) can REFUSE to summarize adult
  // or contentious queries ("I can't help you with that", "that's
  // inappropriate"). Never feed that refusal back into chat — the chat model
  // would just echo it as its own answer. Treat it as "no useful context".
  const REFUSAL_RE =
    /\b(can'?t help|can'?t answer|can'?t provide|cannot help|cannot answer|cannot provide|won'?t help|won'?t answer|not able to|unable to|i'?m (?:sorry|afraid)|i am (?:sorry|afraid)|as an ai|not appropriate|inappropriate|against (?:my|our) (?:policy|guidelines|ethics|principles|values)|don'?t feel comfortable|not comfortable|is there something else)\b/i;
  if (REFUSAL_RE.test(summary)) {
    console.log('[search] Search model refused to summarize — dropping search context for this query');
    return null;
  }

  return `📡 Web search results for "${trimmed}":\n\n${summary || fullContext}`;
}
