export function mergeEnvelope(previous, next, selectedMissionId) {
  const candidate = selectedMissionId && next.mission?.id !== selectedMissionId
    ? { ...next, mission: previous.mission, tracking: next.tracking || previous.tracking }
    : next;
  const oldMission = previous.mission, newMission = candidate.mission;
  const oldTime = oldMission?.trace.length ? Date.parse(oldMission.trace.at(-1).at) : 0;
  const newTime = newMission?.trace.length ? Date.parse(newMission.trace.at(-1).at) : 0;
  const keepOld = oldMission && newMission && oldMission.id === newMission.id && (
    oldMission.revision > newMission.revision ||
    oldMission.revision === newMission.revision && (
      oldTime > newTime || oldTime === newTime && oldMission.trace.length > newMission.trace.length
    )
  );
  return { ...candidate, mission: keepOld ? oldMission : newMission, tracking: candidate.tracking || previous.tracking };
}

export function newDiscordMissionId(previous, next) {
  const mission=next?.mission;
  if(mission?.trigger?.service?.toLowerCase()!=='discord')return undefined;
  return previous?.missions?.some(item=>item.id===mission.id)?undefined:mission.id;
}
