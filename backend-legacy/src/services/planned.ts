import { promises as fs } from 'fs';
import path from 'path';
import { getDataDir } from '../utils/helpers';

const DATA_DIR = path.join(getDataDir(), 'planned');
const FILE_PATH = path.join(DATA_DIR, 'planned.json');

export interface PlannedFeature {
  id: string;
  title: string;
  description: string;
  status: 'done' | 'in-progress' | 'planned';
  icon: string; // emoji icon name
  order: number;
  createdAt: number;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function getAll(): Promise<PlannedFeature[]> {
  try {
    const data = await fs.readFile(FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveAll(features: PlannedFeature[]): Promise<void> {
  await ensureDir();
  await fs.writeFile(FILE_PATH, JSON.stringify(features, null, 2), 'utf-8');
}

export async function getPlannedFeatures(): Promise<PlannedFeature[]> {
  const features = await getAll();
  // Sort by order, then by creation date
  features.sort((a, b) => a.order - b.order || b.createdAt - a.createdAt);
  return features;
}

export async function addPlannedFeature(
  feature: Omit<PlannedFeature, 'id' | 'createdAt' | 'order'> & { order?: number }
): Promise<PlannedFeature> {
  const features = await getAll();
  const newFeature: PlannedFeature = {
    ...feature,
    id: generateId(),
    order: feature.order ?? features.length,
    createdAt: Date.now(),
  };
  features.push(newFeature);
  await saveAll(features);
  return newFeature;
}

export async function updatePlannedFeature(
  id: string,
  updates: Partial<Omit<PlannedFeature, 'id' | 'createdAt'>>
): Promise<PlannedFeature | null> {
  const features = await getAll();
  const index = features.findIndex((f) => f.id === id);
  if (index === -1) return null;
  features[index] = { ...features[index], ...updates };
  await saveAll(features);
  return features[index];
}

export async function deletePlannedFeature(id: string): Promise<boolean> {
  const features = await getAll();
  const filtered = features.filter((f) => f.id !== id);
  if (filtered.length === features.length) return false;
  await saveAll(filtered);
  return true;
}
