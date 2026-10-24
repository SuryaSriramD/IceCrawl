import { FEATURE_FLAG_PRIORITY, type FeatureFlag } from './flags';
import type { Engine } from './types';

export interface PickedEngine {
  engine: Engine;
  supportScore: number;
  unsupported: Set<FeatureFlag>;
}

export function pickEngines(flags: ReadonlySet<FeatureFlag>, registry: readonly Engine[]): PickedEngine[] {
  const active = [...flags];
  const prioritySum = active.reduce((sum, f) => sum + FEATURE_FLAG_PRIORITY[f], 0);
  const threshold = Math.floor(prioritySum / 2);

  let picked: PickedEngine[] = registry
    .map((engine) => ({
      engine,
      supportScore: active.filter((f) => engine.features[f]).reduce((s, f) => s + FEATURE_FLAG_PRIORITY[f], 0),
      unsupported: new Set(active.filter((f) => !engine.features[f])),
    }))
    .filter((p) => p.supportScore >= threshold);

  if (picked.some((p) => p.engine.quality > 0)) picked = picked.filter((p) => p.engine.quality > 0);

  return picked.sort((a, b) => b.supportScore - a.supportScore || b.engine.quality - a.engine.quality);
}
