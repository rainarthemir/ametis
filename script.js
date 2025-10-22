const map = L.map('map').setView([49.894, 2.295], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);

let FeedMessage;
let markers = [];
let allVehicles = [];
let currentShapeLayer = [];
let stopLayer = L.layerGroup().addTo(map);
let stopBlinkTimers = [];
let currentRouteId = null;
let currentTripId = null;
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
  currentShapeLayer.forEach(l => map.removeLayer(l));
  currentShapeLayer = [];
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

  stopsList.forEach(s=>stops[s.stop_id]={ name:s.stop_name, lat:+s.stop_lat, lon:+s.stop_lon });
  routes.forEach(r=>{
    const key=normalizeShort(r.route_short_name||r.route_id);
    routeColors[key]="#"+(r.route_color?.padStart(6,"0")||"000000");
  });
  tripsList.forEach(t=>trips[t.trip_id]={ route_id:t.route_id, headsign:t.trip_headsign, shape_id:t.shape_id });
  shapesList.forEach(s=>{
    if(!shapes[s.shape_id]) shapes[s.shape_id]=[];
    shapes[s.shape_id].push([+s.shape_pt_lat,+s.shape_pt_lon,+s.shape_pt_sequence]);
  });
  for(const id in shapes) shapes[id].sort((a,b)=>a[2]-b[2]);
  stopTimesList.forEach(st=>{
    if(!stopTimes[st.trip_id]) stopTimes[st.trip_id]=[];
    stopTimes[st.trip_id].push({stop_id:st.stop_id,seq:+st.stop_sequence});
  });
  for(const t in stopTimes) stopTimes[t].sort((a,b)=>a.seq-b.seq);
  stopTimesIndexed=true;
  buildRoutesList(routes);
}

/* ===== Правая панель ===== */
function buildRoutesList(routes){
  const container=document.getElementById("routesList");
  routes.forEach(r=>{
    const key=normalizeShort(r.route_short_name||r.route_id);
    const color=routeColors[key];
    const item=document.createElement("div");
    item.className="route-item";
    item.innerHTML=`
      <input type="checkbox" class="route-checkbox" id="route-${key}" data-key="${key}" checked>
      <div class="route-color" style="background:${color}"></div>
      <label for="route-${key}" class="m-0">${r.route_short_name||r.route_id}</label>`;
    container.appendChild(item);
    selectedRoutes.add(r.route_id);
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

/* ===== Транспорт ===== */
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
    allVehicles=posFeed.entity.filter(e=>e.vehicle&&e.vehicle.position);
    updateVisibleVehicles(tripUpdates);
  }catch(err){console.error("Ошибка RT:",err);}
}

/* ===== Отображение ===== */
function updateVisibleVehicles(tripUpdates=lastTripUpdates){
  markers.forEach(m=>map.removeLayer(m));
  markers=[];
  clearShapeLayers();
  clearStopLayer();

  const filteredRoutes=[...selectedRoutes].slice(0,4);
  if(selectedRoutes.size>4) console.warn("⚠️ Можно максимум 4 линии.");

  // --- Shape + Stops per route ---
  filteredRoutes.forEach(rid=>{
    const tripIds=Object.keys(trips).filter(tid=>trips[tid].route_id===rid);
    const color=routeColors[normalizeShort(rid)]||"#777";
    tripIds.forEach(tid=>{
      const sh=trips[tid].shape_id;
      if(sh&&shapes[sh]){
        const pts=shapes[sh].map(p=>[p[0],p[1]]);
        const shapeLayer=L.polyline(pts,{color,weight:3,opacity:0.6}).addTo(map);
        currentShapeLayer.push(shapeLayer);
      }
      const stopsList=stopTimes[tid];
      if(stopsList){
        stopsList.forEach(st=>{
          const s=stops[st.stop_id];
          if(s){
            L.circleMarker([s.lat,s.lon],{
              radius:5.5,color:"black",fillColor:"white",fillOpacity:1,weight:1
            }).addTo(stopLayer);
          }
        });
      }
    });
  });

  // --- Vehicles ---
  const filteredVehicles=selectedRoutes.size
    ? allVehicles.filter(e=>{
        const t=trips[e.vehicle.trip?.tripId];
        return t&&selectedRoutes.has(t.route_id);
      })
    : allVehicles;

  filteredVehicles.forEach(e=>{
    const v=e.vehicle;
    const tripId=v.trip?.tripId;
    const t=trips[tripId];
    if(!t)return;
    const color=routeColors[normalizeShort(t.route_id)]||"#666";
    const shortName=t.route_id.toUpperCase();
    const headsign=t.headsign||"";

    let nextStopName="—";
    const tu=tripUpdates[tripId];
    if(tu?.stopTimeUpdate?.length){
      const next=tu.stopTimeUpdate.find(s=>s.arrival?.time*1000>nowMs())||tu.stopTimeUpdate[0];
      if(next)nextStopName=stops[next.stopId]?.name||next.stopId;
    }

    const iconHtml=`
      <div class="bus-icon-wrap">
        <div class="bus-icon" style="background:${color}">${shortName}</div>
        <div class="bus-dir">${headsign}</div>
      </div>`;
    const icon=L.divIcon({html:iconHtml,className:'',iconSize:null});

    const marker=L.marker([v.position.latitude,v.position.longitude],{icon,zIndexOffset:1000})
      .addTo(map)
      .bindPopup(`<b>${shortName}</b><br>${headsign}<br>След. остановка: ${nextStopName}`,{
        autoClose:false,closeOnClick:false
      });

    markers.push(marker);
  });

  console.log("🚍 Отображено:", markers.length, "машин на", filteredRoutes.length, "линиях.");
}

/* ===== Панель и события ===== */
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
    const key=cb.getAttribute("data-key");
    if(anyUnchecked) selectedRoutes.add(key);
    else selectedRoutes.clear();
  });
  updateVisibleVehicles();
});
document.addEventListener("change",e=>{
  if(e.target.classList.contains("route-checkbox")){
    const key=e.target.getAttribute("data-key");
    if(e.target.checked) selectedRoutes.add(key);
    else selectedRoutes.delete(key);
    updateVisibleVehicles();
  }
});
document.getElementById("resetViewBtn").addEventListener("click",()=>{
  selectedRoutes.clear();
  document.querySelectorAll(".route-checkbox").forEach(cb=>cb.checked=false);
  updateVisibleVehicles();
});

/* ===== Инициализация ===== */
(async()=>{
  await initProto();
  await loadStaticData();
  await loadVehicles();
  setInterval(loadVehicles,10000);
})();
