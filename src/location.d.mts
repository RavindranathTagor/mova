export type LocationFix = { latitude: number; longitude: number; accuracy: number | null; timestamp: number; label: string; source: string; evidenceKind: string };
export function readBrowserLocation(geolocation: Geolocation | undefined): Promise<LocationFix>;
export function leafletPoint(location: { latitude: number; longitude: number }): [number, number];
export function locationRequiredForRequest(text: string): boolean;
export function isNearbyPlaceRequest(text: string): boolean;
export function locationErrorMessage(error: { code?: string | number } | null | undefined): string;
