export function visibleExecutionTraces(traces){
  const hasMissionCreatedEvent=traces.some(trace=>trace.kind==='event'&&trace.title==='Mission created');
  return hasMissionCreatedEvent
    ?traces.filter(trace=>!(trace.kind==='state'&&trace.title==='MISSION CREATED'))
    :traces;
}
