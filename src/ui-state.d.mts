import type { Envelope, Mission } from './types';
export function investigationStatus(mission:Mission|null|undefined,pending?:boolean):{label:string;active:boolean};
export function restoreMissionId(envelope:Envelope,preferredId?:string,freshRequest?:boolean):string|undefined;
export function claimOnce(key:string,shown:Set<string>,storage?:Pick<Storage,'getItem'|'setItem'>):boolean;
