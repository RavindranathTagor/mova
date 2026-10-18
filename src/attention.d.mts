import type { Mission } from './types';
export function attentionEventKey(mission:Mission|null|undefined,kind?:'blocked'|'clarification'|'proposal'):string;
export function contextPayload(value:string):{text:string}|null;
export function resumeRequest(missionId:string):{path:string;body:Record<string,never>}|null;
export function missingIssueInputRequest(mission:Mission|null|undefined):Mission['inputRequest']|null;
export function workFailureDetail(mission:Mission|null|undefined):string;
export function alternativeSourceInstruction(mission:Mission|null|undefined):string;
export function readAttentionDrafts(value:unknown):Record<string,string>;
export function isInvalidWorkArgumentsError(value:unknown):boolean;
