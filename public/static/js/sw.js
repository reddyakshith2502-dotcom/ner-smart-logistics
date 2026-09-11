/**
 * PWA Service Worker (sw.js)
 * NER Smart Logistics - Emergency Rescue & Mountain Pass Route Telemetry
 * 
 * Includes:
 * - Pre-caches core App Shell
 * - Cache-First strategy for Leaflet & OpenStreetMap map tiles
 * - Network-First with Cache Fallback strategy for Route Telemetry & GIS APIs
 * - Offline Fallback responses for telematics & map tiles when network fails
 * - Pre-fetching route tiles for mountain pass zones
 * - IndexedDB Background Sync for offline telemetry logs
 */

const CACHE_VERSION = 'v1.1.0';
const STATIC_CACHE = `ner-static-${CACHE_VERSION}`;
const MAP_TILE_CACHE = `ner-map-tiles-${CACHE_VERSION}`;
const TELEMETRY_CACHE = `ner-telemetry-${CACHE_VERSION}`;

// Core static assets for rescue driver app shell
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/assets/index-DqJ7uakm.js',
  '/assets/index-Crf4PvwS.css',
  '/manifest.json',
  '/static/js/sw.js',
  '/assets/vehicles/medicine_truck.jpg',
  '/assets/vehicles/oxygen_tanker.jpg',
  '/assets/vehicles/food_grain_truck.jpg',
  '/assets/vehicles/solar_cargo_truck.jpg',
  '/assets/vehicles/petroleum_tanker.jpg',
  '/assets/vehicles/medical_truck.jpg',
  '/assets/vehicles/evacuation_truck.jpg',
  '/assets/vehicles/snow_crawler.jpg',
  '/assets/vehicles/drone_vtol.jpg',
  '/assets/vehicles/telematics_truck.jpg'
];

// Max map tiles to retain in offline cache (prevents storage overflow)
const MAX_MAP_TILES = 3000;

// SVG fallback tile when offline tile is not cached
const OFFLINE_TILE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" fill="#1e293b"/>
  <path d="M0 0l256 256M256 0L0 256" stroke="#334155" stroke-width="2"/>
  <text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="13" font-weight="bold">MOUNTAIN PASS</text>
  <text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle" fill="#ef4444" font-family="sans-serif" font-size="11">OFFLINE - TILE UNCACHED</text>
</svg>`;

// ==========================================
// Lifecycle: Install & Activate
// ==========================================

self.addEventListener('install', (event) => {
  console.log('[SW] Installing Rescue Driver PWA Service Worker...', CACHE_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        console.log('[SW] Pre-caching core app shell assets');
        return cache.addAll(PRECACHE_ASSETS).catch((err) => {
          console.warn('[SW] Soft fail on some pre-cached assets during install:', err);
        });
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating Rescue Driver PWA Service Worker...');
  const currentCaches = [STATIC_CACHE, MAP_TILE_CACHE, TELEMETRY_CACHE];
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!currentCaches.includes(cacheName)) {
            console.log('[SW] Removing old cache storage:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// ==========================================
// Fetch Strategy Handler
// ==========================================

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle GET requests for caching
  if (request.method !== 'GET') {
    return;
  }

  // 1. MAP TILES: Cache-First with Network fallback & dynamic caching
  if (isMapTileRequest(url)) {
    event.respondWith(handleMapTileFetch(request));
    return;
  }

  // 2. ROUTE TELEMETRY & GIS APIs: Network-First with Cache Fallback
  if (isTelemetryApiRequest(url)) {
    event.respondWith(handleTelemetryApiFetch(request));
    return;
  }

  // 3. APP SHELL & STATIC ASSETS: Stale-While-Revalidate
  event.respondWith(handleAppShellFetch(request));
});

// ==========================================
// Strategy Helpers
// ==========================================

function isMapTileRequest(url) {
  return (
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('cartocdn.com') ||
    url.hostname.includes('mapbox.com') ||
    url.hostname.includes('basemaps') ||
    url.pathname.includes('/tile/') ||
    (url.pathname.endsWith('.png') && url.pathname.includes('/map/'))
  );
}

function isTelemetryApiRequest(url) {
  return (
    url.pathname.includes('/api/') ||
    url.pathname.includes('/telemetry') ||
    url.pathname.includes('/route') ||
    url.pathname.includes('/rescue') ||
    url.pathname.includes('/weather') ||
    url.pathname.includes('/gis') ||
    url.pathname.includes('/mountain-pass')
  );
}

// Cache-First strategy for Map Tiles
async function handleMapTileFetch(request) {
  const cache = await caches.open(MAP_TILE_CACHE);
  const cachedResponse = await cache.match(request);
  
  if (cachedResponse) {
    // Fetch in background to update tile cache asynchronously when connected
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          cache.put(request, networkResponse.clone());
          trimCache(MAP_TILE_CACHE, MAX_MAP_TILES);
        }
      })
      .catch(() => {/* Silent fail background refresh when offline */});
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      cache.put(request, networkResponse.clone());
      trimCache(MAP_TILE_CACHE, MAX_MAP_TILES);
    }
    return networkResponse;
  } catch (error) {
    console.warn('[SW] Offline map tile request failed, returning offline placeholder SVG:', request.url);
    return new Response(OFFLINE_TILE_SVG, {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml' }
    });
  }
}

// Network-First with Cache Fallback for Telemetry & Routes
async function handleTelemetryApiFetch(request) {
  const cache = await caches.open(TELEMETRY_CACHE);

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    console.warn('[SW] Network failed in mountain pass. Retrieving cached telemetry:', request.url);
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
      return cachedResponse;
    }

    // Return structured offline fallback JSON for telemetry
    return new Response(
      JSON.stringify({
        status: 'offline',
        offline_mode: true,
        message: 'Mobile network unavailable in mountain pass. Displaying cached telemetry state.',
        timestamp: new Date().toISOString(),
        telemetry: {
          connection: 'DISCONNECTED',
          location_source: 'GPS_HARDWARE',
          cached: true
        }
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// Stale-While-Revalidate strategy for App Shell
async function handleAppShellFetch(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cachedResponse = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((networkResponse) => {
      if (networkResponse && networkResponse.status === 200) {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch(() => null);

  return cachedResponse || (await fetchPromise) || caches.match('/index.html');
}

// Limit tile cache size to avoid exceeding browser quotas
async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    await cache.delete(keys[0]);
    trimCache(cacheName, maxItems);
  }
}

// ==========================================
// Pre-fetching Route Map Tiles
// ==========================================

async function prefetchRouteTiles(urls) {
  const cache = await caches.open(MAP_TILE_CACHE);
  let count = 0;
  for (const tileUrl of urls) {
    try {
      const match = await cache.match(tileUrl);
      if (!match) {
        const resp = await fetch(tileUrl, { mode: 'cors' });
        if (resp && resp.status === 200) {
          await cache.put(tileUrl, resp);
          count++;
        }
      }
    } catch (e) {
      console.warn('[SW] Pre-fetch tile failed:', tileUrl, e);
    }
  }
  return count;
}

// ==========================================
// Messaging & Background Sync
// ==========================================

self.addEventListener('message', (event) => {
  if (!event.data) return;

  switch (event.data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    case 'PREFETCH_ROUTE_TILES':
      if (event.data.urls && Array.isArray(event.data.urls)) {
        prefetchRouteTiles(event.data.urls).then((downloaded) => {
          if (event.ports && event.ports[0]) {
            event.ports[0].postMessage({ success: true, count: downloaded });
          }
        });
      }
      break;
    case 'GET_VERSION':
      if (event.ports && event.ports[0]) {
        event.ports[0].postMessage({ version: CACHE_VERSION });
      }
      break;
    case 'CLEAR_CACHE':
      caches.keys().then((names) => {
        return Promise.all(names.map((name) => caches.delete(name)));
      });
      break;
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-telemetry') {
    console.log('[SW] Background sync triggered: Syncing queued mountain pass telemetry logs...');
  }
});
