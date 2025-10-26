// main.js — чистый JS, использует protobuf.js и PapaParse (подключены в index.html)

// ---------- НАСТРОЙКИ ----------
const GTFS_BASE = "../gtfs/";   // папка со статическим gtfs (стops.txt, routes.txt)
const GTFS2_BASE = "../gtfs2/"; // папка со вторым gtfs (routes.txt с цветами)
const PROTO_PATH = "../gtfs-realtime.proto"; // proto файл в папке выше
const RT_URL = "https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update";

// окно времени (мин) по умолчанию — можно изменить на UI
const DEFAULT_WINDOW_MIN = 120;
const REFRESH_INTERVAL_MS = 20000; // авто-обновление RT

// ---------- DOM ----------
const qInput = document.getElementById("q");
const suggestionsBox = document.getElementById("suggestions");
const selectedArea = document.getElementById("selectedArea");
const stopNameH2 = document.getElementById("stopName");
const platformFilter = document.getElementById("platformFilter");
const windowMinutesInput = document.getElementById("windowMinutes");
const refreshBtn = document.getElementById("refreshBtn");
const statusBox = document.getElementById("status");
const departuresList = document.getElementById("departuresList");

// ---------- Хранилище данных ----------
let stops = [];            // все остановки (stops.txt)
let routes = {};           // routes by route_id from gtfs
let routes2ByShort = {};   // routes from gtfs2 indexed by route_short_name (for colors)
let mergedStops = {};      // key -> {baseName, memberStopIds:[], platforms:Set()}
let protoRoot = null;      // protobuf root
let rtFeed = null;
let currentMergedKey = null;
let liveTimer = null;

// ---------- Утилиты ----------
function logStatus(text, isError = false){
  statusBox.textContent = text;
  statusBox.style.color = isError ? "#b22" : "inherit";
}
function utcSecondsToLocalTimeStr(ts){
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString();
}
function safeGet(obj, ...names){
  for (const n of names) if (obj && (n in obj)) return obj[n];
  return undefined;
}

// ---------- Парсинг CSV (используем PapaParse) ----------
async function loadCSV(path){
  const r = await fetch(path);
  if (!r.ok) throw new Error("Failed to fetch " + path + " — " + r.status);
  const txt = await r.text();
  return Papa.parse(txt, { header: true, skipEmptyLines: true }).data;
}

// ---------- Загрузка GTFS (stops/routes) ----------
async function loadGTFS(){
  logStatus("Загружаю GTFS (stops, routes)...");
  try {
    const [stopsData, routesData, routes2Data] = await Promise.all([
      loadCSV(GTFS_BASE + "stops.txt"),
      loadCSV(GTFS_BASE + "routes.txt"),
      loadCSV(GTFS2_BASE + "routes.txt").catch(()=>[])
    ]);
    stops = stopsData;
    routes = {};
    for (const r of routesData){ if (r.route_id) routes[r.route_id] = r; }
    routes2ByShort = {};
    for (const r of (routes2Data||[])){ if (r.route_short_name) routes2ByShort[r.route_short_name] = r; }
    logStatus("GTFS загружен: stops=" + stops.length + ", routes=" + Object.keys(routes).length);
  } catch (e){
    logStatus("Ошибка загрузки GTFS: " + e.message, true);
    throw e;
  }
}

// ---------- Построение объединённых остановок ----------
function normalizeNameForGroup(name){
  if (!name) return "";
  // убираем "Quai A/B/C", "Voie 1", "Platform X" и похожие суффиксы
  let s = name.replace(/\s*[-–—]\s*/g, " "); // тире → пробел
  s = s.replace(/\b(?:Quai|Quais|Voie|Platform|Plateforme)\b[^\n,]*/ig, ""); // удаляем суффикс с платформой
  s = s.replace(/\(.+?\)/g, ""); // убрать скобки
  s = s.replace(/\s+/g, " ").trim();
  return s.toLowerCase();
}
function detectPlatformFromName(name){
  if (!name) return null;
  const m = name.match(/\b(?:Quai|Voie|Platform|Plateforme)\b[^\w]*([A-Z0-9]+)\b/i)
         || name.match(/\b([A-Z0-9])\b$/); // fallback single letter at end
  return m ? (m[1]||m[0]).toString() : null;
}

function buildMergedStops(){
  mergedStops = {}; // key -> { baseName, memberStopIds: [], platforms: Set() }
  for (const s of stops){
    const key = normalizeNameForGroup(s.stop_name);
    if (!mergedStops[key]) mergedStops[key] = { baseName: s.stop_name.replace(/\s*(?:Quai|Voie|Platform).*/i,"").trim(), memberStopIds: [], platforms: new Set() };
    mergedStops[key].memberStopIds.push(s.stop_id);
    // platform detection
    const pf = detectPlatformFromName(s.stop_name) || (s.platform_code || s.stop_code);
    if (pf) mergedStops[key].platforms.add(String(pf));
  }
  // convert sets to arrays for UI usage
  for (const k of Object.keys(mergedStops)){
    mergedStops[k].platforms = Array.from(mergedStops[k].platforms).filter(Boolean).sort();
  }
}

// ---------- Поиск подсказок ----------
function searchMergedStops(q){
  if (!q || q.length < 2) return [];
  q = q.toLowerCase();
  const res = [];
  for (const k of Object.keys(mergedStops)){
    if (k.includes(q) || mergedStops[k].baseName.toLowerCase().includes(q)) {
      res.push({ key: k, name: mergedStops[k].baseName, count: mergedStops[k].memberStopIds.length });
    }
  }
  // сортировать по релевантности (просто по длине имени)
  res.sort((a,b)=>a.name.length - b.name.length);
  return res.slice(0, 30);
}

// ---------- Загрузка .proto через protobuf.js ----------
async function loadProto(){
  logStatus("Загружаю gtfs-realtime.proto и инициализирую protobuf...");
  try {
    protoRoot = await protobuf.load(PROTO_PATH);
    logStatus("Proto загружен.");
  } catch(e){
    logStatus("Ошибка загрузки proto: " + e.message, true);
    throw e;
  }
}

// ---------- Загрузка и декодирование GTFS-RT фида ----------
async function fetchRTandDecode(){
  if (!protoRoot) throw new Error("protoRoot не загружен");
  logStatus("Запрашиваю GTFS-RT фид...");
  const r = await fetch(RT_URL);
  if (!r.ok) throw new Error("Ошибка загрузки RT: " + r.status);
  const buffer = await r.arrayBuffer();
  const FeedMessage = protoRoot.lookupType("transit_realtime.FeedMessage");
  // decode
  const decoded = FeedMessage.decode(new Uint8Array(buffer));
  // convert to plain object for удобства
  const obj = FeedMessage.toObject(decoded, { longs: String, enums: String, bytes: String });
  return obj;
}

// ---------- Сбор отправлений для выбранной объединённой остановки ----------
async function collectDeparturesForMergedKey(key, platformFilterVal, windowMinutes){
  const merged = mergedStops[key];
  if (!merged) return [];
  const now = Math.floor(Date.now() / 1000);
  const windowEnd = now + (windowMinutes||DEFAULT_WINDOW_MIN) * 60;

  const feed = await fetchRTandDecode();
  const departures = [];

  if (!feed.entity || !Array.isArray(feed.entity)) return departures;

  for (const ent of feed.entity){
    // TripUpdate может быть в ent.trip_update (proto) — в объекте после toObject поля могут быть camelCase или underscore,
    // поэтому берём обе опции.
    const tripUpdate = ent.trip_update || ent.tripUpdate;
    if (!tripUpdate) continue;

    // trip descriptor
    const trip = tripUpdate.trip || tripUpdate.tripDescriptor || tripUpdate.trip;
    // stop_time_update array
    const stus = tripUpdate.stop_time_update || tripUpdate.stopTimeUpdate || tripUpdate.stopTimeUpdates || [];
    for (const stu of stus){
      const stopId = stu.stop_id || stu.stopId || stu.stopId;
      if (!stopId) continue;
      if (!merged.memberStopIds.includes(stopId)) continue;

      // берем ИМЕННО departure.time — если пусто, пропускаем (требование: показываем отправления, не прибытия)
      const depObj = stu.departure || stu.departure_time || stu.departureTime;
      const depTs = depObj ? Number(depObj.time || depObj) : null;
      if (!depTs) continue;
      if (depTs < now || depTs > windowEnd) continue;

      // platform: сначала смотреть stu.stop_platform (если есть), или platform в stop record
      let platform = stu.platform || stu.stop_platform || stu.stopPlatform || null;
      if (!platform){
        // попробуем из stops таблицы
        const s = stops.find(x=>x.stop_id === stopId);
        platform = detectPlatformFromName(s?.stop_name) || s?.platform_code || s?.stop_code || null;
      }
      if (platformFilterVal && String(platform) !== String(platformFilterVal)) continue;

      // извлечь route info — стараемся из trip (trip.route_id) или из trip.route_short_name
      let routeId = safeGet(trip, "route_id") || safeGet(trip, "routeId") || null;
      let routeShort = safeGet(trip, "route_short_name") || safeGet(trip, "routeShortName") || null;
      // попытаться получить route_color: сначала routes (gtfs) по route_id, затем routes2 по route_short_name
      let color = "#333333";
      if (routeId && routes[routeId] && routes[routeId].route_color) color = "#" + routes[routeId].route_color;
      else if (routeShort && routes2ByShort[routeShort] && routes2ByShort[routeShort].route_color) color = "#" + routes2ByShort[routeShort].route_color;
      // fallback: если route present in routes by id but color absent, maybe route_short_name exists in routes2
      else if (routeShort && routes2ByShort[routeShort] && routes2ByShort[routeShort].route_color) color = "#" + routes2ByShort[routeShort].route_color;

      // headsign
      const headsign = safeGet(tripUpdate, "trip", "trip_headsign") || safeGet(tripUpdate, "trip", "tripHeadsign") || safeGet(tripUpdate, "trip_headsign") || safeGet(stu, "stop_headsign") || "";

      departures.push({
        tripId: safeGet(trip, "trip_id") || safeGet(trip, "tripId") || null,
        routeId,
        routeShort,
        headsign,
        stopId,
        platform,
        departureTime: depTs,
        color
      });
    }
  }

  // сортировка
  departures.sort((a,b)=>a.departureTime - b.departureTime);
  return departures;
}

// ---------- UI: автодополнение / выбор остановки ----------
qInput.addEventListener("input", ()=>{
  const q = qInput.value.trim();
  suggestionsBox.innerHTML = "";
  if (q.length < 2) return;
  const matches = searchMergedStops(q);
  if (matches.length === 0){
    suggestionsBox.innerHTML = "<div class='item'>Совпадений не найдено</div>";
    return;
  }
  for (const m of matches){
    const div = document.createElement("div");
    div.className = "item";
    div.textContent = m.name + (m.count>1 ? `  •  ${m.count} stop(s)` : "");
    div.addEventListener("click", ()=> selectMergedKey(m.key));
    suggestionsBox.appendChild(div);
  }
});

function clearSelectionUI(){
  selectedArea.classList.add("hidden");
  currentMergedKey = null;
  platformFilter.innerHTML = `<option value="">Все</option>`;
  departuresList.innerHTML = "";
}

function selectMergedKey(key){
  currentMergedKey = key;
  const merged = mergedStops[key];
  if (!merged) return;
  stopNameH2.textContent = merged.baseName + (merged.memberStopIds.length>1 ? `  — ${merged.memberStopIds.length} остановок` : "");
  // платформы
  platformFilter.innerHTML = `<option value="">Все</option>`;
  if (merged.platforms && merged.platforms.length){
    for (const p of merged.platforms){
      const o = document.createElement("option");
      o.value = p; o.textContent = p;
      platformFilter.appendChild(o);
    }
  }
  selectedArea.classList.remove("hidden");
  // сразу показываем результаты
  runFetchAndRender();
  // скроем подсказки
  suggestionsBox.innerHTML = "";
}

// ---------- Отрисовка отправлений ----------
function renderDepartures(deps){
  departuresList.innerHTML = "";
  if (!deps || deps.length===0){
    departuresList.innerHTML = "<div class='status'>Нет доступных отправлений в выбранном окне времени.</div>";
    return;
  }
  for (const d of deps){
    const div = document.createElement("div");
    div.className = "departure";

    const badge = document.createElement("div");
    badge.className = "route-badge";
    badge.style.background = d.color || "#333";
    badge.textContent = d.routeShort || d.routeId || "—";

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<div><strong>${d.headsign || "—"}</strong></div>
                      <div style="color:var(--muted);font-size:13px">Остановка: ${d.stopId} ${d.platform ? "• платф. " + d.platform : ""}</div>`;

    const timeDiv = document.createElement("div");
    timeDiv.className = "time";
    timeDiv.textContent = utcSecondsToLocalTimeStr(d.departureTime);

    div.appendChild(badge);
    div.appendChild(info);
    div.appendChild(timeDiv);

    departuresList.appendChild(div);
  }
}

// ---------- Основная логика обновления ----------
let pendingFetchPromise = null;
async function runFetchAndRender(){
  if (!currentMergedKey) return;
  const platformVal = platformFilter.value || "";
  const minutes = parseInt(windowMinutesInput.value || DEFAULT_WINDOW_MIN, 10) || DEFAULT_WINDOW_MIN;
  try {
    logStatus("Запрашиваю отправления (RT)...");
    // cancel previous? просто await
    const deps = await collectDeparturesForMergedKey(currentMergedKey, platformVal, minutes);
    logStatus(`Найдено отправлений: ${deps.length}`);
    renderDepartures(deps);
  } catch(e){
    logStatus("Ошибка получения RT: " + e.message, true);
    departuresList.innerHTML = "";
  }
}

// ---------- Инициализация всего приложения ----------
async function init(){
  try {
    await loadGTFS();
    buildMergedStops();
    await loadProto();

    logStatus("Готово — можно искать остановку.");
    // UI: при выборе платформы/окна — обновляем
    refreshBtn.addEventListener("click", ()=> runFetchAndRender());
    platformFilter.addEventListener("change", ()=> runFetchAndRender());
    windowMinutesInput.addEventListener("change", ()=> runFetchAndRender());

    // авто-обновление
    liveTimer = setInterval(()=> {
      if (currentMergedKey) runFetchAndRender();
    }, REFRESH_INTERVAL_MS);

  } catch(e){
    logStatus("Инициализация не удалась: " + e.message, true);
  }
}

init();
