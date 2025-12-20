// ====== НАСТРОЙКА КАРТЫ ======
const map = L.map('map', {
  center: [49.894, 2.295],
  zoom: 18,
  zoomControl: false,
  dragging: false,
  scrollWheelZoom: false,
  doubleClickZoom: false,
  boxZoom: false,
  keyboard: false,
  tap: false
});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

let FeedMessage;
let stops = {};
let trips = {};
let shapes = {};
let stopTimes = {};
let routeColors = {};
let stopTimesIndexed = false;
let shapeLayer = null;
let stopMarkersLayer = null;
let currentTripId = null;
let currentColor = null;

// ====== УТИЛИТЫ ======
async function loadCsv(path) {
  const res = await fetch(path);
  const text = await res.text();
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const headers = header.split(",");
  return rows.map(line => {
    const cols = line.split(",");
    const o = {};
    headers.forEach((h, i) => o[h] = cols[i]);
    return o;
  });
}

function normalizeShort(name) {
  return (name || "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
}

function getTripIdFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get('trip');
}

// ====== ЗАГРУЗКА GTFS ======
async function loadStaticData() {
  const [stopsList, routes, tripsList, shapesList, stopTimesList] = await Promise.all([
    loadCsv("../gtfs/stops.txt"),
    loadCsv("../gtfs2/routes.txt"),
    loadCsv("../gtfs/trips.txt"),
    loadCsv("../gtfs/shapes.txt"),
    loadCsv("../gtfs/stop_times.txt")
  ]);

  stopsList.forEach(s => stops[s.stop_id] = { name: s.stop_name, lat: +s.stop_lat, lon: +s.stop_lon });

  routes.forEach(r => {
    const key = normalizeShort(r.route_short_name || r.route_id);
    routeColors[key] = "#" + (r.route_color?.padStart(6, "0") || "000000");
  });

  tripsList.forEach(t => {
    trips[t.trip_id] = { route_id: t.route_id, headsign: t.trip_headsign, shape_id: t.shape_id };
  });

  shapesList.forEach(s => {
    if (!shapes[s.shape_id]) shapes[s.shape_id] = [];
    shapes[s.shape_id].push([+s.shape_pt_lat, +s.shape_pt_lon, +s.shape_pt_sequence]);
  });
  for (const id in shapes) shapes[id].sort((a, b) => a[2] - b[2]);

  stopTimesList.forEach(st => {
    if (!stopTimes[st.trip_id]) stopTimes[st.trip_id] = [];
    stopTimes[st.trip_id].push({ stop_id: st.stop_id, seq: +st.stop_sequence });
  });
  for (const t in stopTimes) stopTimes[t].sort((a, b) => a.seq - b.seq);

  stopTimesIndexed = true;
}

// ====== ПРОТО ======
async function initProto() {
  const root = await protobuf.load("../gtfs-realtime.proto");
  FeedMessage = root.lookupType("transit_realtime.FeedMessage");
}

async function fetchFeed(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const buf = await res.arrayBuffer();
  return FeedMessage.decode(new Uint8Array(buf));
}

// ====== ТАБЛО ======
function showCurrentStop(stopId, color, isOnStop = false) {
  const stopName = stops[stopId]?.name || "—";
  const container = document.getElementById("stops-display");
  
  if (isOnStop) {
    // Показываем только текущую остановку
    container.innerHTML = `
      <div class="stop-row stop-active">
        <div class="stop-circle" style="border-color:${color}"></div>
        <div class="stop-name">${stopName} (actuellement)</div>
      </div>
    `;
  } else {
    // Показываем следующие 4 остановки (старый вариант)
    const list = stopTimes[currentTripId];
    if (!list) return;
    
    const nextIdx = list.findIndex(s => s.stop_id === stopId);
    const visibleStops = list.slice(nextIdx, nextIdx + 4);
    
    container.innerHTML = "";
    visibleStops.forEach((s, idx) => {
      const st = stops[s.stop_id];
      if (!st) return;
      const div = document.createElement("div");
      div.className = "stop-row" + (idx === 0 ? " stop-active" : "");
      div.innerHTML = `
        <div class="stop-circle" style="border-color:${color}"></div>
        <div class="stop-name">${st.name}</div>
      `;
      div.style.setProperty("--line-color", color);
      container.appendChild(div);
    });
  }
}

// Определяем, находится ли автобус на остановке по RT данным
function isBusAtStop(tripUpdate) {
  if (!tripUpdate || !tripUpdate.stopTimeUpdate) return { atStop: false, stopId: null };
  
  const now = Math.floor(Date.now() / 1000);
  
  for (const stopUpdate of tripUpdate.stopTimeUpdate) {
    const departureTime = stopUpdate.departure?.time;
    const arrivalTime = stopUpdate.arrival?.time;
    
    if (departureTime && arrivalTime) {
      // Если текущее время между временем прибытия и временем отправления
      if (now >= arrivalTime && now <= departureTime) {
        return { atStop: true, stopId: stopUpdate.stopId };
      }
    } else if (arrivalTime && !departureTime) {
      // Если есть только время прибытия, считаем что автобус на остановке 30 секунд
      if (now >= arrivalTime && now <= arrivalTime + 30) {
        return { atStop: true, stopId: stopUpdate.stopId };
      }
    }
  }
  
  return { atStop: false, stopId: null };
}

// ====== ЗАГРУЗКА И ОТОБРАЖЕНИЕ ТРИПА ======
async function loadTripData(tripId) {
  if (!tripId) {
    document.getElementById("stops-display").innerHTML = '<div class="error">Trip ID не указан в URL. Добавьте ?trip=[tripId]</div>';
    return;
  }

  const [tripFeed, posFeed] = await Promise.all([
    fetchFeed("https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update"),
    fetchFeed("https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-vehicle-position")
  ]);

  const tu = tripFeed.entity.find(e => e.tripUpdate?.trip?.tripId === tripId)?.tripUpdate;
  
  // Проверяем, существует ли трип в статических данных
  if (!trips[tripId]) {
    document.getElementById("stops-display").innerHTML = '<div class="error">Trip ID не найден в расписании</div>';
    return;
  }
  
  if (!tu) {
    document.getElementById("stops-display").innerHTML = '<div class="error">Нет реальных данных для этого маршрута</div>';
    return;
  }

  const trip = trips[tripId];
  const routeId = trip?.route_id;
  const color = routeColors[normalizeShort(routeId)] || "#000";

  document.getElementById("route-square").style.background = color;
  document.getElementById("route-id").textContent = routeId || "--";

  // Проверяем, находится ли автобус на остановке
  const { atStop, stopId } = isBusAtStop(tu);
  
  if (atStop && stopId) {
    // Показываем только текущую остановку
    showCurrentStop(stopId, color, true);
    
    // Центрируем карту на этой остановке
    const stop = stops[stopId];
    if (stop && stop.lat && stop.lon) {
      map.setView([stop.lat, stop.lon], 18);
    }
  } else {
    // Находим следующую остановку по времени
    const next = tu.stopTimeUpdate.find(s => s.arrival?.time * 1000 > Date.now()) || tu.stopTimeUpdate[0];
    const nextStopId = next?.stopId;
    
    if (nextStopId) {
      showCurrentStop(nextStopId, color, false);
      
      // Центрируем карту на следующей остановке
      const stop = stops[nextStopId];
      if (stop && stop.lat && stop.lon) {
        map.setView([stop.lat, stop.lon], 18);
      }
    }
  }

  // Очищаем предыдущие слои
  if (shapeLayer) map.removeLayer(shapeLayer);
  if (stopMarkersLayer) map.removeLayer(stopMarkersLayer);

  // ===== Шейп маршрута =====
  const shapePts = shapes[trip.shape_id];
  if (shapePts && shapePts.length) {
    const coords = shapePts.map(p => [p[0], p[1]]);
    shapeLayer = L.polyline(coords, { color, weight: 7 }).addTo(map);
  }

  // ===== Остановки маршрута =====
  const list = stopTimes[tripId];
  stopMarkersLayer = L.layerGroup();
  list.forEach(s => {
    const st = stops[s.stop_id];
    if (!st) return;
    const circle = L.circleMarker([st.lat, st.lon], {
      radius: 6,
      color: "black",
      weight: 2,
      fillColor: "white",
      fillOpacity: 1
    }).bindTooltip(st.name, { permanent: true, direction: "right", offset: [8, 0] });
    stopMarkersLayer.addLayer(circle);
  });
  stopMarkersLayer.addTo(map);

  currentTripId = tripId;
  currentColor = color;
}

// ====== Автоматическое обновление ======
async function refreshTripStatus() {
  if (!currentTripId) return;

  try {
    const tripFeed = await fetchFeed("https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update");
    
    const tu = tripFeed.entity.find(e => e.tripUpdate?.trip?.tripId === currentTripId)?.tripUpdate;
    if (!tu) return;
    
    const trip = trips[currentTripId];
    const color = routeColors[normalizeShort(trip?.route_id)] || "#000";
    
    // Проверяем, находится ли автобус на остановке
    const { atStop, stopId } = isBusAtStop(tu);
    
    if (atStop && stopId) {
      showCurrentStop(stopId, color, true);
      
      // Обновляем центр карты
      const stop = stops[stopId];
      if (stop && stop.lat && stop.lon) {
        map.setView([stop.lat, stop.lon], 18);
      }
    } else {
      // Находим следующую остановку
      const next = tu.stopTimeUpdate.find(s => s.arrival?.time * 1000 > Date.now()) || tu.stopTimeUpdate[0];
      const nextStopId = next?.stopId;
      
      if (nextStopId) {
        showCurrentStop(nextStopId, color, false);
        
        // Обновляем центр карты
        const stop = stops[nextStopId];
        if (stop && stop.lat && stop.lon) {
          map.setView([stop.lat, stop.lon], 18);
        }
      }
    }
  } catch (err) {
    console.warn("Erreur d'actualisation:", err);
  }
}

// ====== ИНИЦИАЛИЗАЦИЯ ======
(async () => {
  await initProto();
  await loadStaticData();
  
  // Получаем tripId из URL и загружаем данные
  const tripId = getTripIdFromURL();
  await loadTripData(tripId);
  
  // Обновляем данные каждые 3 секунды
  setInterval(refreshTripStatus, 3000);
})();
