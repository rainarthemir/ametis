// main.js — исправленная версия с улучшенной безопасностью и стабильностью
// Использует protobuf.js и PapaParse (подключены в index.html)

// ---------- НАСТРОЙКИ ----------
const GTFS_BASE = "../gtfs/";   // поправлено: теперь путь относительно текущей папки
const GTFS2_BASE = "../gtfs2/";
const PROTO_PATH = "../gtfs-realtime.proto";
const RT_URL = "https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update";

const DEFAULT_WINDOW_MIN = 120;         // окно времени в минутах
const REFRESH_INTERVAL_MS = 20000;      // авто-обновление RT каждые 20 сек

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

// ---------- Хранилище ----------
let stops = [];
let routes = {};
let routes2ByShort = {};
let mergedStops = {};
let protoRoot = null;
let currentMergedKey = null;
let liveTimer = null;
let pendingFetchPromise = null;

// ---------- Утилиты ----------
function logStatus(text, isError = false) {
  statusBox.textContent = text;
  statusBox.style.color = isError ? "#b22" : "inherit";
}

function utcSecondsToLocalTimeStr(ts) {
  if (!ts || isNaN(ts)) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// универсальный безопасный доступ к вложенным свойствам
function safeGet(obj, ...path) {
  return path.reduce(
    (acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined),
    obj
  );
}

// ---------- Парсинг CSV ----------
async function loadCSV(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("Не удалось загрузить " + path + " — " + r.status);
  const txt = await r.text();
  return Papa.parse(txt, { header: true, skipEmptyLines: true }).data;
}

// ---------- Загрузка GTFS ----------
async function loadGTFS() {
  logStatus("Загружаю GTFS (stops, routes)...");
  try {
    const [stopsData, routesData, routes2Data] = await Promise.all([
      loadCSV(GTFS_BASE + "stops.txt"),
      loadCSV(GTFS_BASE + "routes.txt"),
      loadCSV(GTFS2_BASE + "routes.txt").catch(() => []),
    ]);
    stops = stopsData;
    routes = {};
    for (const r of routesData) if (r.route_id) routes[r.route_id] = r;
    routes2ByShort = {};
    for (const r of routes2Data)
      if (r.route_short_name) routes2ByShort[r.route_short_name] = r;
    logStatus(
      `GTFS загружен: stops=${stops.length}, routes=${Object.keys(routes).length}`
    );
  } catch (e) {
    logStatus("Ошибка загрузки GTFS: " + e.message, true);
    throw e;
  }
}

// ---------- Объединённые остановки ----------
function normalizeNameForGroup(name) {
  if (!name) return "";
  let s = name.replace(/\s*[-–—]\s*/g, " ");
  s = s.replace(/\b(?:Quai|Quais|Voie|Platform|Plateforme)\b[^\n,]*/gi, "");
  s = s.replace(/\(.+?\)/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.toLowerCase();
}

function detectPlatformFromName(name) {
  if (!name) return null;
  const m =
    name.match(/\b(?:Quai|Voie|Platform|Plateforme)\b[^\w]*([A-Z0-9]+)\b/i) ||
    name.match(/\b([A-Z0-9])\b$/);
  return m ? (m[1] || m[0]).toString() : null;
}

function buildMergedStops() {
  mergedStops = {};
  for (const s of stops) {
    const key = normalizeNameForGroup(s.stop_name);
    if (!mergedStops[key])
      mergedStops[key] = {
        baseName: s.stop_name
          .replace(/\s*(?:Quai|Voie|Platform).*/i, "")
          .trim(),
        memberStopIds: [],
        platforms: new Set(),
      };
    mergedStops[key].memberStopIds.push(s.stop_id);
    const pf = detectPlatformFromName(s.stop_name) || s.platform_code || s.stop_code;
    if (pf) mergedStops[key].platforms.add(String(pf));
  }
  for (const k of Object.keys(mergedStops)) {
    mergedStops[k].platforms = Array.from(mergedStops[k].platforms)
      .filter(Boolean)
      .sort();
  }
}

// ---------- Поиск остановок ----------
function searchMergedStops(q) {
  if (!q || q.length < 2) return [];
  q = q.toLowerCase();
  const res = [];
  for (const k of Object.keys(mergedStops)) {
    if (k.includes(q) || mergedStops[k].baseName.toLowerCase().includes(q)) {
      res.push({
        key: k,
        name: mergedStops[k].baseName,
        count: mergedStops[k].memberStopIds.length,
      });
    }
  }
  res.sort((a, b) => a.name.length - b.name.length);
  return res.slice(0, 30);
}

// ---------- Загрузка proto ----------
async function loadProto() {
  logStatus("Загружаю gtfs-realtime.proto...");
  try {
    protoRoot = await protobuf.load(PROTO_PATH);
    logStatus("Proto загружен.");
  } catch (e) {
    logStatus("Ошибка загрузки proto: " + e.message, true);
    throw e;
  }
}

// ---------- Получение и декодирование RT ----------
async function fetchRTandDecode() {
  if (!protoRoot) throw new Error("protoRoot не загружен");
  logStatus("Запрашиваю GTFS-RT фид...");
  const r = await fetch(RT_URL);
  if (!r.ok) throw new Error("Ошибка загрузки RT: " + r.status);
  const buffer = await r.arrayBuffer();
  const FeedMessage = protoRoot.lookupType("transit_realtime.FeedMessage");
  const decoded = FeedMessage.decode(new Uint8Array(buffer));
  return FeedMessage.toObject(decoded, {
    longs: String,
    enums: String,
    bytes: String,
  });
}

// ---------- Сбор отправлений ----------
async function collectDeparturesForMergedKey(key, platformFilterVal, windowMinutes) {
  const merged = mergedStops[key];
  if (!merged) return [];
  const now = Math.floor(Date.now() / 1000);
  const windowEnd = now + (windowMinutes || DEFAULT_WINDOW_MIN) * 60;
  const feed = await fetchRTandDecode();
  const departures = [];

  if (!feed.entity || !Array.isArray(feed.entity)) return departures;

  for (const ent of feed.entity) {
    const tripUpdate = ent.trip_update || ent.tripUpdate;
    if (!tripUpdate) continue;

    const trip = tripUpdate.trip || tripUpdate.tripDescriptor;
    if (!trip) continue;

    const stus = tripUpdate.stop_time_update || tripUpdate.stopTimeUpdate || [];
    for (const stu of stus) {
      const stopId = stu.stop_id || stu.stopId;
      if (!stopId) continue;
      if (!merged.memberStopIds.includes(stopId)) continue;

      const depObj = stu.departure || stu.departure_time || stu.departureTime;
      const depTs = depObj ? Number(depObj.time || depObj) : null;
      if (!depTs || depTs < now || depTs > windowEnd) continue;

      let platform =
        stu.platform || stu.stop_platform || stu.stopPlatform || null;
      if (!platform) {
        const s = stops.find((x) => x.stop_id === stopId);
        if (s && s.stop_name)
          platform =
            detectPlatformFromName(s.stop_name) ||
            s.platform_code ||
            s.stop_code ||
            null;
      }
      if (platformFilterVal && String(platform) !== String(platformFilterVal))
        continue;

      const routeId =
        safeGet(trip, "route_id") || safeGet(trip, "routeId") || null;
      const routeShort =
        safeGet(trip, "route_short_name") ||
        safeGet(trip, "routeShortName") ||
        null;

      let color = "#333333";
      if (routeId && routes[routeId]?.route_color)
        color = "#" + routes[routeId].route_color;
      else if (routeShort && routes2ByShort[routeShort]?.route_color)
        color = "#" + routes2ByShort[routeShort].route_color;

      const headsign =
        safeGet(tripUpdate, "trip", "trip_headsign") ||
        safeGet(tripUpdate, "trip", "tripHeadsign") ||
        safeGet(tripUpdate, "trip_headsign") ||
        safeGet(stu, "stop_headsign") ||
        "";

      departures.push({
        tripId: safeGet(trip, "trip_id") || safeGet(trip, "tripId") || null,
        routeId,
        routeShort,
        headsign,
        stopId,
        platform,
        departureTime: depTs,
        color,
      });
    }
  }
  departures.sort((a, b) => a.departureTime - b.departureTime);
  return departures;
}

// ---------- UI ----------
qInput.addEventListener("input", () => {
  const q = qInput.value.trim();
  suggestionsBox.innerHTML = "";
  if (q.length < 2) return;
  const matches = searchMergedStops(q);
  if (matches.length === 0) {
    suggestionsBox.innerHTML = "<div class='item'>Совпадений не найдено</div>";
    return;
  }
  for (const m of matches) {
    const div = document.createElement("div");
    div.className = "item";
    div.textContent = m.name + (m.count > 1 ? `  •  ${m.count} arrêt(s)` : "");
    div.addEventListener("click", () => selectMergedKey(m.key));
    suggestionsBox.appendChild(div);
  }
});

function clearSelectionUI() {
  selectedArea.classList.add("hidden");
  currentMergedKey = null;
  platformFilter.innerHTML = `<option value="">Все</option>`;
  departuresList.innerHTML = "";
}

function selectMergedKey(key) {
  currentMergedKey = key;
  const merged = mergedStops[key];
  if (!merged) return;
  stopNameH2.textContent =
    merged.baseName +
    (merged.memberStopIds.length > 1
      ? `  — ${merged.memberStopIds.length} arrêt(s)`
      : "");
  platformFilter.innerHTML = `<option value="">Все</option>`;
  if (merged.platforms?.length) {
    for (const p of merged.platforms) {
      const o = document.createElement("option");
      o.value = p;
      o.textContent = p;
      platformFilter.appendChild(o);
    }
  }
  selectedArea.classList.remove("hidden");
  suggestionsBox.innerHTML = "";
  runFetchAndRender();
}

// ---------- Отрисовка ----------
function renderDepartures(deps) {
  departuresList.innerHTML = "";
  if (!deps || deps.length === 0) {
    departuresList.innerHTML =
      "<div class='status'>Нет доступных отправлений в выбранном окне времени.</div>";
    return;
  }
  for (const d of deps) {
    const div = document.createElement("div");
    div.className = "departure";

    const badge = document.createElement("div");
    badge.className = "route-badge";
    badge.style.background = d.color || "#333";
    badge.textContent = d.routeShort || d.routeId || "—";

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<div><strong>${d.headsign || "—"}</strong></div>
                      <div style="color:var(--muted);font-size:13px">Остановка: ${d.stopId} ${
      d.platform ? "• платф. " + d.platform : ""
    }</div>`;

    const timeDiv = document.createElement("div");
    timeDiv.className = "time";
    timeDiv.textContent = utcSecondsToLocalTimeStr(d.departureTime);

    div.appendChild(badge);
    div.appendChild(info);
    div.appendChild(timeDiv);

    departuresList.appendChild(div);
  }
}

// ---------- Логика обновления ----------
async function runFetchAndRender() {
  if (!currentMergedKey) return;
  if (pendingFetchPromise) return; // защита от наложения
  const platformVal = platformFilter.value || "";
  const minutes =
    parseInt(windowMinutesInput.value || DEFAULT_WINDOW_MIN, 10) ||
    DEFAULT_WINDOW_MIN;
  try {
    pendingFetchPromise = collectDeparturesForMergedKey(
      currentMergedKey,
      platformVal,
      minutes
    );
    const deps = await pendingFetchPromise;
    logStatus(`Найдено отправлений: ${deps.length}`);
    renderDepartures(deps);
  } catch (e) {
    logStatus("Ошибка получения RT: " + e.message, true);
    departuresList.innerHTML = "";
  } finally {
    pendingFetchPromise = null;
  }
}

// ---------- Инициализация ----------
async function init() {
  try {
    await loadGTFS();
    buildMergedStops();
    await loadProto();

    logStatus("Готово — можно искать остановку.");

    refreshBtn.addEventListener("click", () => runFetchAndRender());
    platformFilter.addEventListener("change", () => runFetchAndRender());
    windowMinutesInput.addEventListener("change", () => runFetchAndRender());

    liveTimer = setInterval(() => {
      if (currentMergedKey) runFetchAndRender();
    }, REFRESH_INTERVAL_MS);
  } catch (e) {
    logStatus("Инициализация не удалась: " + e.message, true);
  }
}

init();
