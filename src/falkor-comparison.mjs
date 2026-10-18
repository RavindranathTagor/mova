export function dispatchDecisionForStep(traces, stepId) {
  for (const trace of [...traces].reverse()) {
    if (trace?.tool !== 'work_graph_ready') continue;
    const result = trace.result;
    if (!result || typeof result !== 'object' || result.releasedStepId !== stepId) continue;
    return {
      source: trace.source === 'FalkorDB' ? 'FalkorDB' : trace.source || 'Unspecified source',
      detail: typeof trace.detail === 'string' ? trace.detail : '',
      query: typeof trace.query === 'string' ? trace.query : '',
      readyStepIds: Array.isArray(result.readyStepIds) ? result.readyStepIds.filter(id => typeof id === 'string') : [],
      dependencyStepIds: Array.isArray(result.dependencyStepIds) ? result.dependencyStepIds.filter(id => typeof id === 'string') : [],
    };
  }
  return undefined;
}
