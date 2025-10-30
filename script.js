const map = L.map('map').setView([49.894, 2.295], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);

let FeedMessage;
let markers = [];
let allVehicles = [];
let currentShapeLayer = null;
let stopLayer = L.layerGroup().addTo(map);
let stopBlinkTimers = [];
let currentRouteId = null;
let currentTripId = null;
let allTripUpdates = {};

const stops = {};
const trips = {};
const shapes = {};
const routeColors = {};
const stopTimes = {};
let stopTimesIndexed = false;

/* ===== Утилиты ===== */
async function loadCsv(path) {
  const res = await fetch(path);
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
  stopBlinkTimers.forEach(id => clearInterval(id));
  stopBlinkTimers = [];
  stopLayer.clearLayers();
}

/* ===== Загрузка GTFS ===== */
async function loadStaticData() {
  console.log("⏳ Загрузка GTFS...");
  const [stopsList, routes, tripsList, shapesList, stopTimesList] = await Promise.all([
    loadCsv("gtfs/stops.txt"),
    loadCsv("gtfs2/routes.txt"),
    loadCsv("gtfs/trips.txt"),
    loadCsv("gtfs/shapes.txt"),
    loadCsv("gtfs/stop_times.txt")
  ]);

  stopsList.forEach(s=>stops[s.stop_id]={ name:s.stop_name, lat:+s.stop_lat, lon:+s.stop_lon });

  routes.forEach(r=>{
    const key = normalizeShort(r.route_short_name || r.route_id);
    routeColors[key] = "#" + (r.route_color?.padStart(6,"0") || "000000");
  });

  tripsList.forEach(t=>{
    trips[t.trip_id] = { route_id:t.route_id, headsign:t.trip_headsign, shape_id:t.shape_id };
  });

  shapesList.forEach(s=>{
    if (!shapes[s.shape_id]) shapes[s.shape_id] = [];
    shapes[s.shape_id].push([+s.shape_pt_lat, +s.shape_pt_lon, +s.shape_pt_sequence]);
  });
  for (const id in shapes) shapes[id].sort((a,b)=>a[2]-b[2]);

  stopTimesList.forEach(st=>{
    if (!stopTimes[st.trip_id]) stopTimes[st.trip_id] = [];
    stopTimes[st.trip_id].push({ stop_id: st.stop_id, seq: +st.stop_sequence });
  });
  for (const t in stopTimes) stopTimes[t].sort((a,b)=>a.seq - b.seq);
  stopTimesIndexed = true;
}

/* ===== Прото ===== */
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

/* ===== Остановки ===== */
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

    const circle = L.circleMarker([st.lat, st.lon], {
      radius: 6.5, color: "black", weight: 1,
      fillColor: fill, fillOpacity: 1,
      stopIndex: idx
    }).addTo(stopLayer);

    const label = L.marker([st.lat, st.lon], {
      icon: L.divIcon({ className: "stop-label", html: st.name, iconSize: null }),
      stopIndex: idx
    }).addTo(stopLayer);
  });

  // сразу обновляем отображение подписей по зуму
  updateStopLabelsVisibility();
}

/* ===== Показ подписей по зуму ===== */
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

/* ===== Автообновление мигания ===== */
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

/* ===== Транспорт ===== */
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

/* ===== Обновление машин ===== */
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
    const tripId = v.trip?.tripId;
    const t = trips[tripId];
    if (!t) return;

    const color = routeColors[normalizeShort(t.route_id)] || "#666";
    const shortName = t.route_id.toUpperCase();
    const headsign = t.headsign || "";

    let nextStopId = null, nextStopName = "—";
    const tu = tripUpdates[tripId];
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
      currentRouteId = t.route_id;
      currentTripId = tripId;
      if (currentShapeLayer) map.removeLayer(currentShapeLayer);
      clearStopLayer();

      if (t.shape_id && shapes[t.shape_id]) {
        const pts = shapes[t.shape_id].map(p=>[p[0],p[1]]);
        currentShapeLayer = L.polyline(pts, { color, weight:4 }).addTo(map);
        map.fitBounds(currentShapeLayer.getBounds());
      }
      if (nextStopId) drawTripStops(tripId, nextStopId);
      updateVisibleVehicles(tripUpdates);
      marker.openPopup();
    });

    markers.push(marker);
  });
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
  setInterval(loadVehicles, 1000);
})();
