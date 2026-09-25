/**
 * Web Search Tool — lets the MODEL decide when to look something up, instead
 * of the app guessing from keywords. This is the main anti-hallucination tool:
 * the model can verify a fact it's unsure about rather than making one up.
 */
import { registerTool } from './index';
import { getWebContext } from '../search';
import type { ToolDefinition, ToolExecutor } from './index';

const definition: ToolDefinition = {
  id: 'web_search',
  name: 'Web Search',
  description:
    'Search the web for current, factual information. Use this when you are unsure about a fact, number, date, price, or anything time-sensitive — instead of guessing.',
  version: '1.0.0',
  icon: '🌐',
  params: [
    { name: 'query', type: 'string', description: 'Search query (e.g. "height of Burj Khalifa in meters")', required: true },
  ],
};

const execute: ToolExecutor = async (params) => {
  const query = String(params.query || '').trim();
  if (!query) {
    return { success: false, output: 'Please provide a search query.' };
  }
  try {
    const context = await getWebContext(query);
    if (!context || !context.trim()) {
      return {
        success: true,
        output: `No useful results found for "${query}". Tell the user you couldn't find reliable information rather than guessing.`,
      };
    }
    return {
      success: true,
      output:
        `[WEB SEARCH RESULTS for "${query}"]\n${context}\n\n` +
        `Answer the user using these results as the source of truth. If the results don't contain the answer, say so honestly — do not guess.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, output: `Web search failed (${msg}). If you don't know the answer, say so honestly.` };
  }
};

export function registerSearchTool(): void {
  registerTool(definition, execute);
}
