import type { GeoLocationEntity } from "@/types/intelligence";

export interface GeoCoordinate {
  latitude: number;
  longitude: number;
  source: "stored" | "gazetteer";
}

const LOCAL_GAZETTEER: Record<string, [number, number]> = {
  amsterdam: [52.3676, 4.9041],
  bangalore: [12.9716, 77.5946],
  bengaluru: [12.9716, 77.5946],
  berlin: [52.52, 13.405],
  cairo: [30.0444, 31.2357],
  chennai: [13.0827, 80.2707],
  delhi: [28.6139, 77.209],
  dubai: [25.2048, 55.2708],
  hyderabad: [17.385, 78.4867],
  india: [20.5937, 78.9629],
  istanbul: [41.0082, 28.9784],
  jakarta: [-6.2088, 106.8456],
  karachi: [24.8607, 67.0011],
  kolkata: [22.5726, 88.3639],
  london: [51.5072, -0.1276],
  "los angeles": [34.0522, -118.2437],
  mumbai: [19.076, 72.8777],
  "new delhi": [28.6139, 77.209],
  "new york": [40.7128, -74.006],
  paris: [48.8566, 2.3522],
  pune: [18.5204, 73.8567],
  "san francisco": [37.7749, -122.4194],
  "sao paulo": [-23.5558, -46.6396],
  seoul: [37.5665, 126.978],
  shanghai: [31.2304, 121.4737],
  singapore: [1.3521, 103.8198],
  sydney: [-33.8688, 151.2093],
  tokyo: [35.6762, 139.6503],
  toronto: [43.6532, -79.3832],
  washington: [38.9072, -77.0369],
  "washington dc": [38.9072, -77.0369],
};

export function resolveGeoCoordinate(location: GeoLocationEntity): GeoCoordinate | null {
  if (isValidLatitude(location.latitude) && isValidLongitude(location.longitude)) {
    return { latitude: location.latitude, longitude: location.longitude, source: "stored" };
  }
  const gazetteerCoordinate = LOCAL_GAZETTEER[normalizeLocationName(location.canonicalName)];
  if (gazetteerCoordinate === undefined) {
    return null;
  }
  return { latitude: gazetteerCoordinate[0], longitude: gazetteerCoordinate[1], source: "gazetteer" };
}

export function offsetEntityAnchor(latitude: number, longitude: number, entityId: string): [number, number] {
  const hash = stableHash(entityId);
  const angle = ((hash % 360) * Math.PI) / 180;
  const distance = 2.4 + (hash % 7) * 0.45;
  const latitudeOffset = Math.sin(angle) * distance;
  const longitudeOffset = Math.cos(angle) * distance;
  return [clampLongitude(longitude + longitudeOffset), clampLatitude(latitude + latitudeOffset)];
}

function normalizeLocationName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function isValidLatitude(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clampLatitude(value: number): number {
  return Math.max(-84, Math.min(84, value));
}

function clampLongitude(value: number): number {
  if (value > 180) {
    return value - 360;
  }
  if (value < -180) {
    return value + 360;
  }
  return value;
}
