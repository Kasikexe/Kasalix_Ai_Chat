/**
 * Converter Tool — converts between units of measurement
 *
 * AI detects when the user asks for a conversion and calls this tool.
 * Supports: temperature, length, weight, volume, speed, data, currency (simple)
 */

import { registerTool } from './index';
import type { ToolDefinition, ToolExecutor } from './index';

// ─── Conversion Tables ────────────────────────────────────

type UnitCategory = {
  id: string;
  name: string;
  units: { id: string; name: string; toBase: (val: number) => number; fromBase: (val: number) => number }[];
};

const categories: UnitCategory[] = [
  {
    id: 'temperature',
    name: 'Temperature',
    units: [
      { id: 'celsius', name: 'Celsius (°C)', toBase: (v) => v, fromBase: (v) => v },
      { id: 'fahrenheit', name: 'Fahrenheit (°F)', toBase: (v) => (v - 32) * 5 / 9, fromBase: (v) => v * 9 / 5 + 32 },
      { id: 'kelvin', name: 'Kelvin (K)', toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
    ],
  },
  {
    id: 'length',
    name: 'Length',
    units: [
      { id: 'millimeter', name: 'Millimeters', toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
      { id: 'centimeter', name: 'Centimeters', toBase: (v) => v / 100, fromBase: (v) => v * 100 },
      { id: 'meter', name: 'Meters', toBase: (v) => v, fromBase: (v) => v },
      { id: 'kilometer', name: 'Kilometers', toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
      { id: 'inch', name: 'Inches', toBase: (v) => v * 0.0254, fromBase: (v) => v / 0.0254 },
      { id: 'foot', name: 'Feet', toBase: (v) => v * 0.3048, fromBase: (v) => v / 0.3048 },
      { id: 'yard', name: 'Yards', toBase: (v) => v * 0.9144, fromBase: (v) => v / 0.9144 },
      { id: 'mile', name: 'Miles', toBase: (v) => v * 1609.344, fromBase: (v) => v / 1609.344 },
    ],
  },
  {
    id: 'weight',
    name: 'Weight',
    units: [
      { id: 'gram', name: 'Grams', toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
      { id: 'kilogram', name: 'Kilograms', toBase: (v) => v, fromBase: (v) => v },
      { id: 'ton', name: 'Tons (metric)', toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
      { id: 'pound', name: 'Pounds', toBase: (v) => v * 0.453592, fromBase: (v) => v / 0.453592 },
      { id: 'ounce', name: 'Ounces', toBase: (v) => v * 0.0283495, fromBase: (v) => v / 0.0283495 },
    ],
  },
  {
    id: 'volume',
    name: 'Volume',
    units: [
      { id: 'milliliter', name: 'Milliliters', toBase: (v) => v / 1000, fromBase: (v) => v * 1000 },
      { id: 'liter', name: 'Liters', toBase: (v) => v, fromBase: (v) => v },
      { id: 'gallon', name: 'Gallons (US)', toBase: (v) => v * 3.78541, fromBase: (v) => v / 3.78541 },
      { id: 'quart', name: 'Quarts (US)', toBase: (v) => v * 0.946353, fromBase: (v) => v / 0.946353 },
      { id: 'cup', name: 'Cups', toBase: (v) => v * 0.236588, fromBase: (v) => v / 0.236588 },
    ],
  },
  {
    id: 'speed',
    name: 'Speed',
    units: [
      { id: 'kmh', name: 'km/h', toBase: (v) => v / 3.6, fromBase: (v) => v * 3.6 },
      { id: 'mph', name: 'mph', toBase: (v) => v * 0.44704, fromBase: (v) => v / 0.44704 },
      { id: 'ms', name: 'm/s', toBase: (v) => v, fromBase: (v) => v },
      { id: 'knot', name: 'Knots', toBase: (v) => v * 0.514444, fromBase: (v) => v / 0.514444 },
    ],
  },
  {
    id: 'data',
    name: 'Data',
    units: [
      { id: 'byte', name: 'Bytes', toBase: (v) => v, fromBase: (v) => v },
      { id: 'kilobyte', name: 'Kilobytes', toBase: (v) => v * 1024, fromBase: (v) => v / 1024 },
      { id: 'megabyte', name: 'Megabytes', toBase: (v) => v * 1024 * 1024, fromBase: (v) => v / (1024 * 1024) },
      { id: 'gigabyte', name: 'Gigabytes', toBase: (v) => v * 1024 * 1024 * 1024, fromBase: (v) => v / (1024 * 1024 * 1024) },
    ],
  },
  {
    id: 'currency',
    name: 'Currency (approximate)',
    units: [
      { id: 'usd', name: 'USD ($)', toBase: (v) => v, fromBase: (v) => v },
      { id: 'eur', name: 'EUR (€)', toBase: (v) => v * 1.08, fromBase: (v) => v / 1.08 },
      { id: 'gbp', name: 'GBP (£)', toBase: (v) => v * 1.27, fromBase: (v) => v / 1.27 },
      { id: 'jpy', name: 'JPY (¥)', toBase: (v) => v * 0.0067, fromBase: (v) => v / 0.0067 },
      { id: 'czk', name: 'CZK (Kč)', toBase: (v) => v * 0.041, fromBase: (v) => v / 0.041 },
    ],
  },
];

// ─── Detection: parse "convert X [from] to Y" patterns ────

const CONVERT_PATTERNS = [
  /convert\s+(\d+(?:\.\d+)?)\s*([a-zA-Z°©®]+)\s*(?:to|in|→)\s*([a-zA-Z°©®]+)/i,
  /(\d+(?:\.\d+)?)\s*([a-zA-Z°©®]+)\s*(?:to|in|→|as)\s*([a-zA-Z°©®]+)/i,
  /(?:what is|how much is|how many)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z°©®]+)\s*(?:to|in|as)\s*([a-zA-Z°©®]+)/i,
  /(\d+(?:\.\d+)?)\s*(?:degrees?\s*)?([a-zA-Z°©®]+)\s*(?:is|equals?)\s*(?:.*?)\s*([a-zA-Z°©®]+)/i,
];

// Unit aliases (common abbreviations)
const UNIT_ALIASES: Record<string, string> = {
  '°c': 'celsius', 'c': 'celsius', 'celsius': 'celsius',
  '°f': 'fahrenheit', 'f': 'fahrenheit', 'fahrenheit': 'fahrenheit',
  'k': 'kelvin', 'kelvin': 'kelvin',
  'mm': 'millimeter', 'millimeter': 'millimeter', 'millimeters': 'millimeter',
  'cm': 'centimeter', 'centimeter': 'centimeter', 'centimeters': 'centimeter',
  'm': 'meter', 'meter': 'meter', 'meters': 'meter', 'metre': 'meter',
  'km': 'kilometer', 'kilometer': 'kilometer', 'kilometers': 'kilometer',
  'in': 'inch', 'inch': 'inch', 'inches': 'inch', '"': 'inch',
  'ft': 'foot', 'foot': 'foot', 'feet': 'foot', '\'': 'foot',
  'yd': 'yard', 'yard': 'yard', 'yards': 'yard',
  'mi': 'mile', 'mile': 'mile', 'miles': 'mile',
  'g': 'gram', 'gram': 'gram', 'grams': 'gram',
  'kg': 'kilogram', 'kilogram': 'kilogram', 'kilograms': 'kilogram',
  't': 'ton', 'ton': 'ton', 'tons': 'ton', 'tonne': 'ton',
  'lb': 'pound', 'pound': 'pound', 'lbs': 'pound', 'pounds': 'pound',
  'oz': 'ounce', 'ounce': 'ounce', 'ounces': 'ounce',
  'ml': 'milliliter', 'milliliter': 'milliliter', 'milliliters': 'milliliter',
  'l': 'liter', 'liter': 'liter', 'liters': 'liter', 'litre': 'liter',
  'gal': 'gallon', 'gallon': 'gallon', 'gallons': 'gallon',
  'qt': 'quart', 'quart': 'quart', 'quarts': 'quart',
  'kph': 'kmh', 'km/h': 'kmh', 'kmh': 'kmh',
  'mph': 'mph',
  'm/s': 'ms', 'ms': 'ms',
  'b': 'byte', 'byte': 'byte', 'bytes': 'byte',
  'kb': 'kilobyte', 'kilobyte': 'kilobyte',
  'mb': 'megabyte', 'megabyte': 'megabyte',
  'gb': 'gigabyte', 'gigabyte': 'gigabyte',
  '$': 'usd', 'usd': 'usd', 'dollar': 'usd', 'dollars': 'usd',
  '€': 'eur', 'eur': 'eur', 'euro': 'eur', 'euros': 'eur',
  '£': 'gbp', 'gbp': 'gbp', 'pound sterling': 'gbp',
  '¥': 'jpy', 'jpy': 'jpy', 'yen': 'jpy',
  'kč': 'czk', 'czk': 'czk', 'koruna': 'czk', 'crown': 'czk',
};

/** Find a unit ID from any alias */
function resolveUnit(text: string): string | null {
  const clean = text.replace(/°|°|"|'/g, '').trim().toLowerCase();
  return UNIT_ALIASES[clean] || null;
}

/** Try to detect what conversion the user wants */
function detectConversion(input: string): { value: number; from: string; to: string; category: string } | null {
  for (const pattern of CONVERT_PATTERNS) {
    const match = input.match(pattern);
    if (match) {
      const value = parseFloat(match[1]);
      const fromRaw = match[2];
      const toRaw = match[3];

      const fromId = resolveUnit(fromRaw);
      const toId = resolveUnit(toRaw);

      if (fromId && toId) {
        // Find the category that contains both units
        for (const cat of categories) {
          const fromUnit = cat.units.find((u) => u.id === fromId);
          const toUnit = cat.units.find((u) => u.id === toId);
          if (fromUnit && toUnit) {
            return { value, from: fromId, to: toId, category: cat.name };
          }
        }
      }
    }
  }
  return null;
}

function runConversion(value: number, fromId: string, toId: string): { result: number; formula: string } | null {
  for (const cat of categories) {
    const fromUnit = cat.units.find((u) => u.id === fromId);
    const toUnit = cat.units.find((u) => u.id === toId);
    if (fromUnit && toUnit) {
      const baseValue = fromUnit.toBase(value);
      const result = toUnit.fromBase(baseValue);
      return { result, formula: `${value} ${fromUnit.name} → ${result.toFixed(4)} ${toUnit.name}` };
    }
  }
  return null;
}

// ─── Tool Definition ──────────────────────────────────────

const definition: ToolDefinition = {
  id: 'converter',
  name: 'Unit Converter',
  description: 'Convert between units: temperature, length, weight, volume, speed, data, and currency',
  version: '1.0.0',
  icon: '🔄',
  params: [
    { name: 'value', type: 'number', description: 'The numeric value to convert', required: true },
    { name: 'from', type: 'string', description: 'Source unit (e.g., celsius, feet, kg)', required: true },
    { name: 'to', type: 'string', description: 'Target unit (e.g., fahrenheit, meters, lb)', required: true },
  ],
};

const execute: ToolExecutor = async (params, ctx) => {
  const value = typeof params.value === 'number' ? params.value : parseFloat(String(params.value));
  const fromId = resolveUnit(String(params.from || ''));
  const toId = resolveUnit(String(params.to || ''));

  if (isNaN(value)) {
    return { success: false, output: 'Please provide a numeric value to convert.' };
  }
  if (!fromId || !toId) {
    return { success: false, output: `Could not recognize units. Try: "convert 100 cm to inches"` };
  }

  const conversion = runConversion(value, fromId, toId);
  if (!conversion) {
    return {
      success: false,
      output: `Cannot convert between those units — they may be in different categories.`,
    };
  }

  return {
    success: true,
    output: conversion.formula,
    data: { value, from: fromId, to: toId, result: conversion.result },
  };
};

/** Auto-detect conversion intent from user input */
function detect(input: string): { confidence: number; params: Record<string, unknown> } | null {
  const result = detectConversion(input);
  if (result) {
    return {
      confidence: 0.9,
      params: { value: result.value, from: result.from, to: result.to },
    };
  }
  return null;
}

// ─── Register ─────────────────────────────────────────────

export function registerConverterTool(): void {
  registerTool(definition, execute);
  console.log(`[tools] Converter registered with ${categories.length} unit categories`);
}

// Also export for direct use by other modules
export { categories, runConversion, detectConversion, resolveUnit, CONVERT_PATTERNS };
