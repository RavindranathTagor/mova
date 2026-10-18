export function isAllowedRequestOrigin(origin, requestOrigin, allowedOrigins) {
  return !origin || allowedOrigins.has(origin) || origin === requestOrigin;
}
