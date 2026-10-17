export function readBrowserLocation(geolocation) {
  if (!geolocation?.getCurrentPosition) return Promise.reject(Object.assign(new Error('Browser location is unavailable.'), { code: 'UNAVAILABLE' }));
  return new Promise((resolve, reject) => geolocation.getCurrentPosition(position => {
    const latitude = position?.coords?.latitude, longitude = position?.coords?.longitude;
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180 || !Number.isFinite(position.timestamp)) {
      reject(Object.assign(new Error('The browser returned invalid location coordinates.'), { code: 'INVALID_POSITION' }));
      return;
    }
    resolve({ latitude, longitude, accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null, timestamp: position.timestamp, label: 'Your current location', source: 'Browser geolocation', evidenceKind: 'observed' });
  }, error => reject(Object.assign(new Error(error?.message || 'Browser location could not be obtained.'), { code: error?.code === 1 ? 'PERMISSION_DENIED' : error?.code === 3 ? 'TIMEOUT' : 'UNAVAILABLE' })), { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }));
}

export function leafletPoint(location) {
  return [location.latitude, location.longitude];
}

export function locationRequiredForRequest(text) {
  return /\b(?:nearby|near me|around me|closest|nearest|within\s+\d+(?:\.\d+)?\s*(?:m|km|meters?|kilometers?)|near\s+my\s+(?:current\s+)?location)\b/i.test(text)
    || /\b(?:navigate|directions?|route|drive|walk|transit|take me|get me|reach)\b/i.test(text);
}

export function isNearbyPlaceRequest(text) {
  return /\b(?:nearby|near me|around me|closest|nearest|within\s+\d+(?:\.\d+)?\s*(?:m|km|meters?|kilometers?)|near\s+my\s+(?:current\s+)?location)\b/i.test(text);
}

export function locationErrorMessage(error) {
  if (error?.code === 'PERMISSION_DENIED' || error?.code === 1) return 'Location permission was denied. Enter a city, address, or landmark to continue.';
  if (error?.code === 'UNAVAILABLE') return 'This browser cannot provide location. Enter a city, address, or landmark to continue.';
  return 'A fresh location could not be obtained. Enter a city, address, or landmark to continue.';
}
