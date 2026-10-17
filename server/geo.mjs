export function validPoint(value) {
  const latitude = value?.latitude ?? value?.lat;
  const longitude = value?.longitude ?? value?.lon ?? value?.lng;
  return Number.isFinite(latitude) && Math.abs(latitude) <= 90 && Number.isFinite(longitude) && Math.abs(longitude) <= 180
    ? { latitude, longitude }
    : null;
}

export function distanceMeters(a, b) {
  const first = validPoint(a), second = validPoint(b);
  if (!first || !second) throw new Error('Distance requires valid geographic coordinates.');
  const radians = degrees => degrees * Math.PI / 180;
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const arc = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(Math.max(0, 1 - arc)));
}

export function resolveManualPlace(result, placeId) {
  const places = Array.isArray(result?.places) ? result.places.filter(place => validPoint(place.location)) : [];
  if (!placeId && result?.resolution && result.resolution.status !== 'matched') return null;
  const selectedId = result?.resolution?.status === 'matched' ? result.resolution.selectedPlaceId : placeId;
  if (selectedId) return places.find(place => place.id === selectedId) || null;
  return places.length === 1 ? places[0] : null;
}
