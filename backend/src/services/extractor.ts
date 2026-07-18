import { streamChat } from './ollama';
import { getMemory, mergeMemoryEntries } from './memory';
import type { Message } from '../types';

const EXTRACTOR_MODEL = process.env.EXTRACTOR_MODEL || 'qwen2.5:3b';

interface ExtractionResult {
  changes: Record<string, Record<string, string>>;
}

/**
 * Analyze a conversation turn and decide if any info should be remembered.
 * This runs asynchronously after the assistant responds, so it doesn't block the user.
 */
export async function extractMemoryFromTurn(
  userId: string,
  userMessage: string,
  assistantResponse: string
): Promise<void> {
  try {
    const currentMemory = await getMemory(userId);
    if (!currentMemory.enabled) return;

    const memoryJson = JSON.stringify(currentMemory.categories, null, 2);

    // Truncate to avoid overwhelming the small extraction model
    const truncatedUser = userMessage.length > 500
      ? userMessage.slice(0, 500) + '...'
      : userMessage;
    const truncatedResponse = assistantResponse.length > 2000
      ? assistantResponse.slice(0, 2000) + '...'
      : assistantResponse;

    const systemPrompt = `You extract personal info about the user from chat messages.

EXTRACT when the user shares:
- Their name, age, gender, location, job, hobbies, skills, goals, preferences
- Projects they work on, languages they use, tools they like
- Personal facts, opinions about tech, things they enjoy
- Corrections or updates to info they shared before

DO NOT EXTRACT:
- Random facts, general knowledge questions, one-off jokes
- Code snippets that aren't about the user's own projects

EXAMPLES:
User: "My name is Filip" -> { "changes": { "Person": { "name": "Filip" } } }
User: "I'm 17 years old" -> { "changes": { "Person": { "age": "17" } } }
User: "I work on a Unity game" -> { "changes": { "Projects": { "game_dev": "Working on a Unity game" } } }

Current memory: ${memoryJson}

Last user message: "${truncatedUser}"
Assistant: "${truncatedResponse}"

Respond with JSON: { "changes": { "Category": { "key": "value" } } }
Use categories like Person, Projects, Hobbies, Work, Preferences, Skills.
Add new categories if needed. Update values when the user corrects them.
If nothing to extract, respond with { "changes": {} }
ONLY output the JSON object. No other text.`;

    const extractionMessages: Message[] = [
      { role: 'system', content: systemPrompt },
    ];

    let rawOutput = '';
    try {
      await streamChat(
        EXTRACTOR_MODEL,
        extractionMessages,
        (chunk) => {
          rawOutput += chunk;
        },
        { think: false }
      );
    } catch (e) {
      // Extraction failure is non-critical — don't crash the app
      console.error('[extractor] Extraction call failed:', e);
      return;
    }

    // Parse the JSON response
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('[extractor] No JSON found in extraction output');
      return;
    }

    let result: ExtractionResult;
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[extractor] Failed to parse extraction JSON:', e);
      return;
    }

    if (!result.changes || Object.keys(result.changes).length === 0) {
      console.log('[extractor] No changes to memory');
      return;
    }

    console.log('[extractor] Memory changes detected:', JSON.stringify(result.changes));
    await mergeMemoryEntries(userId, result.changes);
    console.log('[extractor] Memory updated successfully');
  } catch (e) {
    console.error('[extractor] Extraction failed:', e);
  }
}
