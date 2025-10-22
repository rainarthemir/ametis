const map = L.map('map').setView([49.894, 2.295], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);

let FeedMessage;
let markers = [];
let allVehicles = [];
let shapeLayers = [];
let stopLayer = L.layerGroup().addTo(map);
let stopBlinkTimers = [];
let lastTripUpdates = {};
let selectedRoutes = new Set();

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
function clearShapeLayers() {
  shapeLayers.forEach(l => map.removeLayer(l));
  shapeLayers = [];
}

/* ===== Загрузка GTFS ===== */
async function loadStaticData() {
  const [stopsList, routes, tripsList, shapesList, stopTimesList] = await Promise.all([
    loadCsv("gtfs/stops.txt"),
    loadCsv("gtfs2/routes.txt"),
    loadCsv("gtfs/trips.txt"),
    loadCsv("gtfs/shapes.txt"),
    loadCsv("gtfs/stop_times.txt")
  ]);

  // Остановки
  stopsList.forEach(s=>stops[s.stop_id]={ name:s.stop_name, lat:+s.stop_lat, lon:+s.stop_lon });

  // Маршруты (по short_name)
  routes.forEach(r=>{
    const key = r.route_short_name || r.route_id;
    routeColors[key] = "#" + (r.route_color?.padStart(6,"0") || "000000");
  });

  // Трипсы
  tripsList.forEach(t=>{
    trips[t.trip_id] = { route_id:t.route_id, headsign:t.trip_headsign, shape_id:t.shape_id };
  });

  // Шейпы
  shapesList.forEach(s=>{
    if(!shapes[s.shape_id]) shapes[s.shape_id]=[];
    shapes[s.shape_id].push([+s.shape_pt_lat,+s.shape_pt_lon,+s.shape_pt_sequence]);
  });
  for(const id in shapes) shapes[id].sort((a,b)=>a[2]-b[2]);

  // Остановки по трипам
  stopTimesList.forEach(st=>{
    if(!stopTimes[st.trip_id]) stopTimes[st.trip_id]=[];
    stopTimes[st.trip_id].push({ stop_id: st.stop_id, seq: +st.stop_sequence });
  });
  for(const t in stopTimes) stopTimes[t].sort((a,b)=>a.seq-b.seq);
  stopTimesIndexed = true;

  buildRoutesList(routes);
}

/* ===== Правая панель ===== */
function buildRoutesList(routes){
  const container=document.getElementById("routesList");
  container.innerHTML="";
  routes.forEach(r=>{
    const id=r.route_id;
    const short=r.route_short_name || id;
    const color=routeColors[short];
    const item=document.createElement("div");
    item.className="route-item";
    item.innerHTML=`
      <input type="checkbox" class="route-checkbox" id="route-${id}" data-id="${id}" checked>
      <div class="route-color" style="background:${color}"></div>
      <label for="route-${id}" class="m-0">${short}</label>`;
    container.appendChild(item);
    selectedRoutes.add(id);
  });
}

/* ===== Прото ===== */
async function initProto() {
  const root=await protobuf.load("gtfs-realtime.proto");
  FeedMessage=root.lookupType("transit_realtime.FeedMessage");
}
async function fetchFeed(url){
  const res=await fetch(url);
  const buf=await res.arrayBuffer();
  return FeedMessage.decode(new Uint8Array(buf));
}

/* ===== Отрисовка остановок ===== */
function drawStopsForTrip(tripId) {
  if (!stopTimesIndexed) return;
  const list = stopTimes[tripId];
  if (!list || !list.length) return;
  list.forEach(s=>{
    const st = stops[s.stop_id];
    if (!st) return;
    L.circleMarker([st.lat, st.lon], {
      radius: 5.5,
      color: "black",
      fillColor: "white",
      fillOpacity: 1,
      weight: 1
    }).addTo(stopLayer);
  });
}

/* ===== RT ===== */
async function loadVehicles(){
  try{
    const [posFeed, tripFeed]=await Promise.all([
      fetchFeed("https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-vehicle-position"),
      fetchFeed("https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update")
    ]);
    const tripUpdates={};
    tripFeed.entity.forEach(e=>{
      const tid=e.tripUpdate?.trip?.tripId;
      if(tid) tripUpdates[tid]=e.tripUpdate;
    });
    lastTripUpdates=tripUpdates;
    allVehicles=posFeed.entity.filter(e=>e.vehicle && e.vehicle.position);
    updateVisible(tripUpdates);
  }catch(err){console.error("Ошибка RT:",err);}
}

/* ===== Основная логика ===== */
function updateVisible(tripUpdates = lastTripUpdates){
  markers.forEach(m=>map.removeLayer(m));
  markers=[];
  clearShapeLayers();
  clearStopLayer();

  const filteredRoutes=[...selectedRoutes].slice(0,4);
  if(selectedRoutes.size>4) console.warn("⚠️ Можно максимум 4 линии.");

  // --- Shape + Stops per route ---
  filteredRoutes.forEach(rid=>{
    const tripIds=Object.keys(trips).filter(tid=>trips[tid].route_id===rid);
    const color=routeColors[trips[tripIds[0]]?.route_id] || "#777";
    tripIds.forEach(tid=>{
      const sh=trips[tid].shape_id;
      if(sh && shapes[sh]){
        const pts=shapes[sh].map(p=>[p[0],p[1]]);
        const shapeLayer=L.polyline(pts,{color,weight:3,opacity:0.6}).addTo(map);
        shapeLayers.push(shapeLayer);
      }
      drawStopsForTrip(tid);
    });
  });

  // --- Vehicles ---
  const filteredVehicles = selectedRoutes.size
    ? allVehicles.filter(e=>{
        const t=trips[e.vehicle.trip?.tripId];
        return t && selectedRoutes.has(t.route_id);
      })
    : allVehicles;

  filteredVehicles.forEach(e=>{
    const v = e.vehicle;
    const tripId = v.trip?.tripId;
    const t = trips[tripId];
    if (!t) return;

    const color = routeColors[t.route_id] || "#666";
    const shortName = t.route_id.toUpperCase();
    const headsign = t.headsign || "";

    // исправленная логика "следующая остановка"
    let nextStopName = "—";
    const tu = tripUpdates[tripId];
    if (tu?.stopTimeUpdate?.length) {
      const now = nowMs();
      const futureStops = tu.stopTimeUpdate.filter(s => s.arrival?.time*1000 > now);
      const next = futureStops.length ? futureStops[0] : tu.stopTimeUpdate[tu.stopTimeUpdate.length - 1];
      if (next) nextStopName = stops[next.stopId]?.name || next.stopId;
    }

    const iconHtml = `
      <div class="bus-icon-wrap">
        <div class="bus-icon" style="background:${color}">${shortName}</div>
        <div class="bus-dir">${headsign}</div>
      </div>`;
    const icon = L.divIcon({ html: iconHtml, className:'', iconSize:null });

    const marker = L.marker([v.position.latitude, v.position.longitude], { icon, zIndexOffset: 1000 })
      .addTo(map)
      .bindPopup(`<b>${shortName}</b><br>${headsign}<br>След. остановка: ${nextStopName}`, {
        autoClose:false,
        closeOnClick:false
      });

    markers.push(marker);
  });
}

/* ===== Панель управления ===== */
document.getElementById("toggleSidebar").addEventListener("click",()=>{
  const sidebar=document.getElementById("sidebar");
  sidebar.classList.toggle("open");
  const icon=document.querySelector("#toggleSidebar i");
  icon.className=sidebar.classList.contains("open")?"bi bi-chevron-left":"bi bi-chevron-right";
});
document.getElementById("toggleAll").addEventListener("click",()=>{
  const all=document.querySelectorAll(".route-checkbox");
  const anyUnchecked=[...all].some(cb=>!cb.checked);
  all.forEach(cb=>{
    cb.checked=anyUnchecked;
    const id=cb.getAttribute("data-id");
    if(anyUnchecked) selectedRoutes.add(id);
    else selectedRoutes.clear();
  });
  updateVisible();
});
document.addEventListener("change",e=>{
  if(e.target.classList.contains("route-checkbox")){
    const id=e.target.getAttribute("data-id");
    if(e.target.checked) selectedRoutes.add(id);
    else selectedRoutes.delete(id);
    updateVisible();
  }
});
document.getElementById("resetViewBtn").addEventListener("click",()=>{
  selectedRoutes.clear();
  document.querySelectorAll(".route-checkbox").forEach(cb=>cb.checked=false);
  updateVisible();
});

/* ===== Инициализация ===== */
(async()=>{
  await initProto();
  await loadStaticData();
  await loadVehicles();
  setInterval(loadVehicles, 10000);
})();
