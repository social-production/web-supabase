/**
 * Nominatim-backed geocoding with local DB fallback for typed place search.
 * Mirrors FastAPI's public Nominatim usage so LocationPicker typeahead works
 * on a fresh local install (not only against pre-seeded `locations` rows).
 */

export type GeocodeResult = {
  id?: string | null;
  providerPlaceId: string | null;
  displayLabel: string;
  latitude: number | null;
  longitude: number | null;
  region: string | null;
  country: string | null;
  precision: string;
  isOnline: boolean;
};

const NOMINATIM_BASE = (Deno.env.get('GEOCODING_PROVIDER_URL') ?? 'https://nominatim.openstreetmap.org').replace(
  /\/$/,
  ''
);
const USER_AGENT =
  Deno.env.get('GEOCODING_USER_AGENT') ?? 'SocialProductionLocal/0.1 (local-dev; contact: local@socialproduction.dev)';

function normalizeNominatim(item: Record<string, unknown>): GeocodeResult | null {
  const lat = Number(item.lat);
  const lon = Number(item.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const displayLabel = String(item.display_name ?? '').trim();
  if (!displayLabel) return null;
  const address = (item.address && typeof item.address === 'object' ? item.address : {}) as Record<
    string,
    unknown
  >;
  const region =
    (address.state as string | undefined) ||
    (address.region as string | undefined) ||
    (address.county as string | undefined) ||
    (address.city as string | undefined) ||
    null;
  const country = (address.country as string | undefined) ?? null;
  const placeId = item.place_id;
  const osmType = item.osm_type;
  const osmId = item.osm_id;
  let providerPlaceId: string | null = null;
  if (placeId != null) providerPlaceId = `nominatim:${placeId}`;
  else if (osmType && osmId != null) providerPlaceId = `osm:${osmType}:${osmId}`;

  return {
    id: null,
    providerPlaceId,
    displayLabel: displayLabel.slice(0, 240),
    latitude: Math.round(lat * 1e6) / 1e6,
    longitude: Math.round(lon * 1e6) / 1e6,
    region: region ? String(region).slice(0, 120) : null,
    country: country ? String(country).slice(0, 120) : null,
    precision: 'approximate',
    isOnline: false
  };
}

async function nominatimGet(
  path: string,
  params: Record<string, string>
): Promise<GeocodeResult[]> {
  const qs = new URLSearchParams({
    format: 'jsonv2',
    addressdetails: '1',
    ...params
  });
  const url = `${NOMINATIM_BASE}${path}?${qs.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT
      },
      signal: controller.signal
    });
    if (!response.ok) return [];
    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : payload && typeof payload === 'object' ? [payload] : [];
    const out: GeocodeResult[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const mapped = normalizeNominatim(row as Record<string, unknown>);
      if (mapped) out.push(mapped);
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function searchPlacesExternal(
  query: string,
  limit = 8
): Promise<GeocodeResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  return nominatimGet('/search', {
    q,
    limit: String(Math.min(Math.max(limit, 1), 10))
  });
}

export async function reverseGeocodeExternal(
  lat: number,
  lon: number
): Promise<GeocodeResult | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const items = await nominatimGet('/reverse', {
    lat: String(lat),
    lon: String(lon)
  });
  return items[0] ?? null;
}
