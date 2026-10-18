import type { Envelope } from './types';
export function mergeEnvelope(previous: Envelope, next: Envelope, selectedMissionId?: string): Envelope;
export function newDiscordMissionId(previous:Envelope,next:Envelope):string|undefined;
