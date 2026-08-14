/**
 * Tool Registration — imported once to register all built-in tools
 */

import { registerConverterTool } from './converter';
import { registerCalculatorTool } from './calculator';
import { registerTextTool } from './text';
import { registerRandomTool } from './random';
import { registerJSONTool } from './json';
import { registerColorTool } from './color';
import { registerDateTimeTool } from './datetime';
import { registerHashTool } from './hash';
import { registerSearchTool } from './search';
import { getAllTools } from './index';

export function registerAllTools(): void {
  registerConverterTool();
  registerCalculatorTool();
  registerTextTool();
  registerRandomTool();
  registerJSONTool();
  registerColorTool();
  registerDateTimeTool();
  registerHashTool();
  registerSearchTool();

  const tools = getAllTools();
  console.log(`[tools] ${tools.length} tool(s) registered: ${tools.map((t) => t.name).join(', ')}`);
}
