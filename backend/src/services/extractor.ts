import { streamChat } from './ollama';
import { getMemory, mergeMemoryEntries } from './memory';
import { getModelAssignment } from './model-assignments';
import type { Message } from '../types';

interface ExtractionResult {
  changes: Record<string, Record<string, string>>;
}

/**
 * Analyze the user's message and decide if any info should be remembered.
 * This runs asynchronously after the assistant responds, so it doesn't block the user.
 * IMPORTANT: Only the user's message is analyzed — NOT the AI's response.
 * This prevents the AI's own hallucinations from being saved as memory.
 */
export async function extractMemoryFromTurn(
  userId: string,
  userMessage: string
): Promise<void> {
  try {
    const currentMemory = await getMemory(userId);
    if (!currentMemory.enabled) return;

    const memoryJson = JSON.stringify(currentMemory.categories, null, 2);

    // Truncate to avoid overwhelming the small extraction model
    const truncatedUser = userMessage.length > 500
      ? userMessage.slice(0, 500) + '...'
      : userMessage;

    const systemPrompt = `You extract personal info about the user from their messages.

CRITICAL RULE: Only extract information that the USER explicitly states about themselves.
NEVER extract information from the AI assistant's responses — only the user's own words matter.

EXTRACT when the user shares:
- Their name, age, gender, location, job, hobbies, skills, goals, preferences
- Projects they work on, languages they use, tools they like
- Personal facts, opinions about tech, things they enjoy
- Corrections or updates to info they shared before

DO NOT EXTRACT:
- Random facts, general knowledge questions, one-off jokes
- Code snippets that aren't about the user's own projects
- Information the AI assistant mentioned — only trust the USER's statements

EXAMPLES:
User: "My name is Filip" -> { "changes": { "Person": { "name": "Filip" } } }
User: "I'm 17 years old" -> { "changes": { "Person": { "age": "17" } } }
User: "I work on a Unity game" -> { "changes": { "Projects": { "game_dev": "Working on a Unity game" } } }

Current memory: ${memoryJson}

User message: "${truncatedUser}"

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
      const extractorModel = await getModelAssignment('extraction');
      await streamChat(
        extractorModel,
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
