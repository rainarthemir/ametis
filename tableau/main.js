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
  let marker = null;
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
  function calculateBearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    return (θ * 180 / Math.PI + 360) % 360;
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
  
  // ====== ВЫПАДАЮЩИЙ СПИСОК ======
  async function loadTripsDropdown() {
    const tripFeed = await fetchFeed("https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update");
    const select = document.getElementById("tripList");
    select.innerHTML = '<option value="">-- choisir un trip actif --</option>';
    tripFeed.entity.forEach(e => {
      const t = e.tripUpdate?.trip;
      if (!t) return;
      const opt = document.createElement("option");
      opt.value = t.tripId;
      opt.textContent = t.tripId;
      select.appendChild(opt);
    });
  }
  
  // ====== ТАБЛО ======
  function showStops(tripId, nextStopId, color) {
    const list = stopTimes[tripId];
    if (!list) return;
    const nextIdx = list.findIndex(s => s.stop_id === nextStopId);
    const nextStopName = stops[nextStopId]?.name || "—";
    document.getElementById("next-stop-name").textContent = nextStopName;
  
    const visibleStops = list.slice(nextIdx, nextIdx + 4);
    const container = document.getElementById("stops-display");
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
  
  // ====== ВЫБОР ТРИПА ======
  async function selectTrip(tripId) {
    if (!tripId) return;
  
    const [tripFeed, posFeed] = await Promise.all([
      fetchFeed("https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update"),
      fetchFeed("https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-vehicle-position")
    ]);
  
    const tu = tripFeed.entity.find(e => e.tripUpdate?.trip?.tripId === tripId)?.tripUpdate;
    if (!tu) return;
  
    const next = tu.stopTimeUpdate.find(s => s.arrival?.time * 1000 > Date.now()) || tu.stopTimeUpdate[0];
    const nextStopId = next?.stopId;
    const trip = trips[tripId];
    const routeId = trip?.route_id;
    const color = routeColors[normalizeShort(routeId)] || "#000";
  
    document.getElementById("route-square").style.background = color;
    document.getElementById("route-id").textContent = routeId || "--";
    showStops(tripId, nextStopId, color);
  
    const stop = stops[nextStopId];
    if (stop && stop.lat && stop.lon) map.setView([stop.lat, stop.lon], 18);
  
    if (marker) map.removeLayer(marker);
    if (shapeLayer) map.removeLayer(shapeLayer);
    if (stopMarkersLayer) map.removeLayer(stopMarkersLayer);
  
    // ===== Шейп маршрута =====
    const shapePts = shapes[trip.shape_id];
    if (shapePts && shapePts.length) {
      const coords = shapePts.map(p => [p[0], p[1]]);
      shapeLayer = L.polyline(coords, { color, weight: 7 }).addTo(map);
    }
  
    // ===== Поиск автобуса =====
    let vehicle = posFeed.entity.find(e => e.vehicle?.trip?.tripId === tripId);
    if (!vehicle && trip?.route_id) {
      vehicle = posFeed.entity.find(e => e.vehicle?.trip?.routeId === trip.route_id);
    }
  
    const msg = document.getElementById("no-bus-msg");
    if (!vehicle) {
      msg.classList.remove("hidden");
      console.warn("🚫 Aucun bus trouvé pour trip:", tripId);
    } else {
      msg.classList.add("hidden");
      const pos = vehicle.vehicle.position;
      const shortName = (trip.route_id || "?").toUpperCase();
      const iconHtml = `<div class="bus-circle" style="background:${color};border-color:white;">${shortName}</div>`;
      const icon = L.divIcon({ html: iconHtml, className: "", iconSize: [36, 36] });
      marker = L.marker([pos.latitude, pos.longitude], { icon }).addTo(map);
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
      const [tripFeed, posFeed] = await Promise.all([
        fetchFeed("https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update"),
        fetchFeed("https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-vehicle-position")
      ]);
  
      const tu = tripFeed.entity.find(e => e.tripUpdate?.trip?.tripId === currentTripId)?.tripUpdate;
      if (!tu) return;
  
      const next = tu.stopTimeUpdate.find(s => s.arrival?.time * 1000 > Date.now()) || tu.stopTimeUpdate[0];
      const nextStopId = next?.stopId;
      const nextStop = stops[nextStopId];
      if (!nextStop) return;
  
      showStops(currentTripId, nextStopId, currentColor);
      document.getElementById("next-stop-name").textContent = nextStop.name;
  
      let vehicle = posFeed.entity.find(e => e.vehicle?.trip?.tripId === currentTripId);
      if (!vehicle) vehicle = posFeed.entity.find(e => e.vehicle?.trip?.routeId === trips[currentTripId]?.route_id);
  
      if (vehicle) {
        const pos = vehicle.vehicle.position;
        if (marker) marker.setLatLng([pos.latitude, pos.longitude]);
        map.setView([nextStop.lat, nextStop.lon], 18);
        document.getElementById("no-bus-msg").classList.add("hidden");
      } else {
        document.getElementById("no-bus-msg").classList.remove("hidden");
      }
    } catch (err) {
      console.warn("Erreur d’actualisation:", err);
    }
  }
  setInterval(refreshTripStatus, 3000);
  
  // ====== ИНИЦИАЛИЗАЦИЯ ======
  (async () => {
    await initProto();
    await loadStaticData();
    await loadTripsDropdown();
  
    document.getElementById("tripList").addEventListener("change", e => {
      selectTrip(e.target.value);
    });
  
    setInterval(loadTripsDropdown, 30000);
  })();
  