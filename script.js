const map = L.map('map').setView([49.894, 2.295], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);

let FeedMessage;
let markers = [];
let allVehicles = [];
let currentShapeLayer = null;
let stopLayer = L.layerGroup().addTo(map);
let currentRouteId = null;
let currentTripId = null;
let allTripUpdates = {};

const stops = {};            // stop_id → { name, lat, lon } (из GTFS)
const stopsGtfs = {};        // stop_id → stop_name (из GTFS)
const trips = {};            // GTFS trip_id → { route_id, headsign, shape_id }
const shapes = {};           // shape_id → [[lat,lon], ...] (из GTFS, но не используется)
const routeColors = {};      // route_short_name → цвет (из GTFS2)
const stopTimes = {};        // GTFS trip_id → [{ stop_id, seq, departure_time }]

// Новые структуры для GTFS2
let gtfs2Trips = {};         // GTFS2 trip_id → { route_id, shape_id, service_id, stop_names, departure_time }
let gtfs2Calendar = {};      // service_id → { monday, tuesday, ... }
let gtfsToGtfs2Map = {};     // кэш: GTFS trip_id → GTFS2 trip_id
let stopTimesIndexed = false;

/* ===== Утилиты ===== */
async function loadCsv(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  const text = await res.text();
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const headers = header.split(",");
  return rows.map(line => {
    const cols = line.split(",");
    const o = {};
    headers.forEach((h,i)=>o[h]=cols[i]);
    return o;
  });
}

function nowMs() { return Date.now(); }

function normalizeShort(name) {
  if (!name) return "";
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]/g,"");
}

function clearStopLayer() {
  stopLayer.clearLayers();
}

function getCurrentDayMask() {
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  return days[new Date().getDay()];
}

function isTripActiveToday(service_id) {
  if (!service_id) return true;
  const cal = gtfs2Calendar[service_id];
  if (!cal) return true;
  const today = getCurrentDayMask();
  return cal[today] === true;
}

/* ===== Загрузка GTFS ===== */
async function loadStaticData() {
  console.log("⏳ Загрузка GTFS...");
  // Загружаем все необходимые файлы (обрабатываем отсутствие shapes.txt в первом наборе)
  const [stopsList, routes, tripsList, shapesList, stopTimesList,
         trips2, stopTimes2, calendar, calendarDates, stops2List] = await Promise.all([
    loadCsv("gtfs/stops.txt"),
    loadCsv("gtfs2/routes.txt"),
    loadCsv("gtfs/trips.txt"),
    loadCsv("gtfs/shapes.txt").catch(()=>[]),   // может не быть
    loadCsv("gtfs/stop_times.txt"),
    loadCsv("gtfs2/trips.txt"),
    loadCsv("gtfs2/stop_times.txt"),
    loadCsv("gtfs2/calendar.txt").catch(()=>[]),
    loadCsv("gtfs2/calendar_dates.txt").catch(()=>[]),
    loadCsv("gtfs2/stops.txt").catch(()=>[])    // остановки из GTFS2 (если есть)
  ]);

  // --- stops (GTFS) ---
  stopsList.forEach(s=>{
    stopsGtfs[s.stop_id] = s.stop_name;
    stops[s.stop_id] = { name:s.stop_name, lat:+s.stop_lat, lon:+s.stop_lon };
  });

  // --- stops (GTFS2) для сопоставления названий ---
  const stopNameFromGtfs2 = {};
  stops2List.forEach(s=>{
    stopNameFromGtfs2[s.stop_id] = s.stop_name;
  });

  // --- routes (GTFS2) ---
  routes.forEach(r=>{
    const key = normalizeShort(r.route_short_name || r.route_id);
    routeColors[key] = "#" + (r.route_color?.padStart(6,"0") || "000000");
  });

  // --- trips (GTFS) ---
  tripsList.forEach(t=>{
    trips[t.trip_id] = { route_id:t.route_id, headsign:t.trip_headsign, shape_id:t.shape_id };
  });

  // --- shapes (GTFS) – игнорируем, т.к. будем брать из GTFS2 ---
  if (shapesList.length) {
    shapesList.forEach(s=>{
      if (!shapes[s.shape_id]) shapes[s.shape_id] = [];
      shapes[s.shape_id].push([+s.shape_pt_lat, +s.shape_pt_lon, +s.shape_pt_sequence]);
    });
    for (const id in shapes) shapes[id].sort((a,b)=>a[2]-b[2]);
  }

  // --- stop_times (GTFS) с временем отправления ---
  stopTimesList.forEach(st=>{
    if (!stopTimes[st.trip_id]) stopTimes[st.trip_id] = [];
    let dep = st.departure_time;
    if (typeof dep === 'string' && dep.includes(':')) {
      const parts = dep.split(':').map(Number);
      dep = parts[0]*3600 + parts[1]*60 + (parts[2]||0);
    } else {
      dep = Number(dep);
    }
    stopTimes[st.trip_id].push({
      stop_id: st.stop_id,
      seq: +st.stop_sequence,
      departure_time: dep
    });
  });
  for (const t in stopTimes) stopTimes[t].sort((a,b)=>a.seq - b.seq);

  // --- calendar (GTFS2) ---
  calendar.forEach(c=>{
    const serviceId = c.service_id;
    gtfs2Calendar[serviceId] = {
      monday: c.monday === '1',
      tuesday: c.tuesday === '1',
      wednesday: c.wednesday === '1',
      thursday: c.thursday === '1',
      friday: c.friday === '1',
      saturday: c.saturday === '1',
      sunday: c.sunday === '1'
    };
  });

  // --- Строим индекс GTFS2 ---
  const stopTimes2ByTrip = {};
  stopTimes2.forEach(st=>{
    if (!stopTimes2ByTrip[st.trip_id]) stopTimes2ByTrip[st.trip_id] = [];
    let dep = st.departure_time;
    if (typeof dep === 'string' && dep.includes(':')) {
      const parts = dep.split(':').map(Number);
      dep = parts[0]*3600 + parts[1]*60 + (parts[2]||0);
    } else {
      dep = Number(dep);
    }
    stopTimes2ByTrip[st.trip_id].push({
      stop_id: st.stop_id,
      seq: +st.stop_sequence,
      departure_time: dep
    });
  });
  for (const t in stopTimes2ByTrip) stopTimes2ByTrip[t].sort((a,b)=>a.seq - b.seq);

  trips2.forEach(t=>{
    const tid = t.trip_id;
    const stList = stopTimes2ByTrip[tid] || [];
    if (stList.length === 0) return;
    // Получаем последовательность названий остановок (сначала из GTFS2, потом из GTFS)
    const stopNames = stList.map(s => {
      return stopNameFromGtfs2[s.stop_id] || stopsGtfs[s.stop_id] || s.stop_id;
    });
    const departureTime = stList[0].departure_time;
    gtfs2Trips[tid] = {
      route_id: t.route_id,
      shape_id: t.shape_id,
      service_id: t.service_id,
      stop_names: stopNames,
      departure_time: departureTime
    };
  });

  stopTimesIndexed = true;
  console.log("✅ GTFS загружено. trips в gtfs2:", Object.keys(gtfs2Trips).length);
}

/* ===== Сопоставление trip_id ===== */
function findMatchingGtfs2Trip(gtfsTripId) {
  if (gtfsToGtfs2Map[gtfsTripId]) return gtfsToGtfs2Map[gtfsTripId];

  const gtfsStops = stopTimes[gtfsTripId];
  if (!gtfsStops || gtfsStops.length === 0) {
    //console.warn("Нет stop_times для GTFS trip", gtfsTripId);
    return null;
  }
  const gtfsStopNames = gtfsStops.map(s => stopsGtfs[s.stop_id] || s.stop_id);
  const gtfsDeparture = gtfsStops[0].departure_time;

  let bestMatch = null;
  let bestDiff = Infinity;

  for (const [tid2, info] of Object.entries(gtfs2Trips)) {
    // Фильтр по дню недели
    if (!isTripActiveToday(info.service_id)) continue;

    // Сравнение последовательности названий
    if (info.stop_names.length !== gtfsStopNames.length) continue;
    let match = true;
    for (let i = 0; i < info.stop_names.length; i++) {
      if (info.stop_names[i] !== gtfsStopNames[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    // Сравнение времени отправления (в секундах)
    const diff = Math.abs(info.departure_time - gtfsDeparture);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestMatch = tid2;
    }
  }

  // Порог 10 минут (600 секунд)
  if (bestMatch && bestDiff <= 600) {
    gtfsToGtfs2Map[gtfsTripId] = bestMatch;
    //console.log(`Сопоставлено: GTFS trip ${gtfsTripId} → GTFS2 trip ${bestMatch} (diff ${bestDiff} сек)`);
    return bestMatch;
  } else {
    //console.warn(`Не найдено соответствие для GTFS trip ${gtfsTripId}`);
    return null;
  }
}

/* ===== Отображение остановок ===== */
function drawTripStops(tripId, nextStopId) {
  if (!stopTimesIndexed) return;
  const list = stopTimes[tripId];
  if (!list || !list.length) return;
  clearStopLayer();

  const nextIdx = nextStopId ? list.findIndex(s => s.stop_id === nextStopId) : -1;

  list.forEach((s, idx) => {
    const st = stops[s.stop_id];
    if (!st) return;

    let fill = "white";
    if (nextIdx >= 0) {
      if (idx < nextIdx) fill = "#ccc";
      else if (idx === nextIdx) fill = "yellow";
      else fill = "white";
    }

    const circleRadius = 6.5;
    const extraOffset = 20;
    const labelOffsetX = circleRadius + extraOffset;
    const labelOffsetY = -(circleRadius + extraOffset);

    const circle = L.circleMarker([st.lat, st.lon], {
      radius: circleRadius,
      color: "black",
      weight: 1,
      fillColor: fill,
      fillOpacity: 1,
      stopIndex: idx
    }).addTo(stopLayer);

    const label = L.marker([st.lat, st.lon], {
      icon: L.divIcon({ className: "stop-label", html: st.name, iconSize: null }),
      stopIndex: idx
    }).addTo(stopLayer);

    const el = label.getElement();
    if (el) el.style.transform = `translate(${labelOffsetX}px, ${labelOffsetY}px)`;
  });

  updateStopLabelsVisibility();
}

/* ===== Подписи остановок ===== */
const MIN_ZOOM_LABELS = 15;
function updateStopLabelsVisibility() {
  const zoom = map.getZoom();
  stopLayer.eachLayer(layer => {
    if (layer instanceof L.Marker && layer.getElement()) {
      const idx = layer.options.stopIndex;
      if (idx === 0 || idx === stopTimes[currentTripId]?.length-1) {
        layer.getElement().style.display = "block";
      } else {
        layer.getElement().style.display = zoom >= MIN_ZOOM_LABELS ? "block" : "none";
      }
    }
  });
}
map.on("zoomend", updateStopLabelsVisibility);

/* ===== Мигание остановок ===== */
function updateBlinkingStop() {
  if (!currentTripId || !stopTimesIndexed) return;
  const list = stopTimes[currentTripId];
  if (!list || !list.length) return;

  let nextIdx = -1;
  const now = nowMs();
  const tu = allTripUpdates[currentTripId];
  if (tu?.stopTimeUpdate?.length) {
    const future = tu.stopTimeUpdate.find(s=>s.arrival?.time*1000 > now);
    const next = future || tu.stopTimeUpdate[tu.stopTimeUpdate.length - 1];
    if (next) nextIdx = list.findIndex(s=>s.stop_id===next.stopId);
  }

  stopLayer.eachLayer(layer => {
    if (!(layer instanceof L.CircleMarker)) return;
    const stopIdx = layer.options.stopIndex;
    if (stopIdx === nextIdx) {
      layer._blinking = true;
      layer.getElement()?.classList.add("blinking");
    } else {
      layer._blinking = false;
      layer.getElement()?.classList.remove("blinking");
      layer.setStyle({ fillColor: stopIdx < nextIdx ? "#ccc" : "white" });
    }
  });
}
setInterval(updateBlinkingStop, 1000);

/* ===== Обновление видимых машин ===== */
function updateVisibleVehicles(tripUpdates) {
  markers.forEach(m=>map.removeLayer(m));
  markers = [];

  const filtered = currentRouteId
    ? allVehicles.filter(e=>{
        const t = trips[e.vehicle.trip?.tripId];
        return t && t.route_id === currentRouteId;
      })
    : allVehicles;

  filtered.forEach(e=>{
    const v = e.vehicle;
    const gtfsTripId = v.trip?.tripId;
    if (!gtfsTripId) return;

    const gtfs2TripId = findMatchingGtfs2Trip(gtfsTripId);
    if (!gtfs2TripId) return; // пропускаем, если не нашли

    const tripInfo2 = gtfs2Trips[gtfs2TripId];
    if (!tripInfo2) return;

    const routeId2 = tripInfo2.route_id;
    const color = routeColors[normalizeShort(routeId2)] || "#666";
    const shortName = routeId2.toUpperCase();
    const headsign = trips[gtfsTripId]?.headsign || "";

    let nextStopId = null, nextStopName = "—";
    const tu = tripUpdates[gtfsTripId];
    if (tu?.stopTimeUpdate?.length) {
      const now = nowMs();
      const future = tu.stopTimeUpdate.find(s=>s.arrival?.time*1000 > now);
      const next = future || tu.stopTimeUpdate[tu.stopTimeUpdate.length - 1];
      if (next) {
        nextStopId = next.stopId;
        nextStopName = stops[next.stopId]?.name || next.stopId;
      }
    }

    const iconHtml = `
      <div class="bus-icon-wrap">
        <div class="bus-icon" style="background:${color}">${shortName}</div>
        <div class="bus-dir">${headsign}</div>
      </div>`;
    const icon = L.divIcon({ html: iconHtml, className:'', iconSize:[28,40] });
    const marker = L.marker([v.position.latitude, v.position.longitude], { icon })
      .addTo(map)
      .bindPopup(`<b>${shortName}</b><br>${headsign}<br>След. остановка: ${nextStopName}`, {
        autoClose:false,
        closeOnClick:false
      });

    marker.on("click", ()=>{
      currentRouteId = routeId2;
      currentTripId = gtfsTripId;
      if (currentShapeLayer) map.removeLayer(currentShapeLayer);
      clearStopLayer();

      // Используем shape из GTFS2
      const shapeId = tripInfo2.shape_id;
      if (shapeId && shapes[shapeId]) {
        const pts = shapes[shapeId].map(p=>[p[0],p[1]]);
        currentShapeLayer = L.polyline(pts, { color, weight:4 }).addTo(map);
        map.fitBounds(currentShapeLayer.getBounds());
      } else {
        // Если shape нет в shapes (из GTFS), попробуем загрузить из GTFS2 напрямую? 
        // Для этого нужно было бы загрузить shapes.txt из GTFS2.
        console.warn("Shape не найден для", gtfs2TripId);
      }
      if (nextStopId) drawTripStops(gtfsTripId, nextStopId);
      updateVisibleVehicles(tripUpdates);
      marker.openPopup();
    });

    markers.push(marker);
  });
}

/* ===== Загрузка RT ===== */
async function initProto() {
  const root = await protobuf.load("gtfs-realtime.proto");
  FeedMessage = root.lookupType("transit_realtime.FeedMessage");
}
async function fetchFeed(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP "+res.status);
  const buf = await res.arrayBuffer();
  return FeedMessage.decode(new Uint8Array(buf));
}
async function loadVehicles() {
  try {
    const [posFeed, tripFeed] = await Promise.all([
      fetchFeed("https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-vehicle-position"),
      fetchFeed("https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update")
    ]);

    allTripUpdates = {};
    tripFeed.entity.forEach(e=>{
      const tid = e.tripUpdate?.trip?.tripId;
      if (tid) allTripUpdates[tid] = e.tripUpdate;
    });

    allVehicles = posFeed.entity.filter(e=>e.vehicle && e.vehicle.position);
    updateVisibleVehicles(allTripUpdates);
  } catch(err) {
    console.error("Ошибка RT:", err);
  }
}

/* ===== Кнопка "Показать всё" ===== */
document.getElementById("resetViewBtn").addEventListener("click", ()=>{
  currentRouteId = null;
  currentTripId = null;
  if (currentShapeLayer) map.removeLayer(currentShapeLayer);
  clearStopLayer();
  updateVisibleVehicles(allTripUpdates);
});

/* ===== Инициализация ===== */
(async ()=>{
  await initProto();
  await loadStaticData();
  await loadVehicles();
  setInterval(loadVehicles, 5000); // обновление каждые 5 секунд
})();
