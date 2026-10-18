import type { Trace } from './types';

export function dispatchDecisionForStep(traces: Trace[], stepId: string): {
  source: string;
  detail: string;
  query: string;
  readyStepIds: string[];
  dependencyStepIds: string[];
} | undefined;
