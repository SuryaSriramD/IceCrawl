export const FEATURE_FLAG_PRIORITY = {
  actions: 20,
  waitFor: 1,
  screenshot: 10,
  'screenshot@fullScreen': 10,
  pdf: 100,
  document: 100,
  location: 10,
  mobile: 10,
  skipTlsVerification: 10,
  stealthProxy: 20,
  disableAdblock: 10,
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAG_PRIORITY;

export function featureSet(on: FeatureFlag[]): Record<FeatureFlag, boolean> {
  const out = {} as Record<FeatureFlag, boolean>;
  for (const flag of Object.keys(FEATURE_FLAG_PRIORITY) as FeatureFlag[]) out[flag] = on.includes(flag);
  return out;
}
