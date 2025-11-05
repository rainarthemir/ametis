// ---------------------
// main.js - RATP Style Board
// ---------------------

// ---------- НАСТРОЙКИ ----------
const GTFS_BASE = "../gtfs/";
const GTFS2_BASE = "../gtfs2/";
const PROTO_PATH = "../gtfs-realtime.proto";
const RT_URL = "https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update";

const DEFAULT_WINDOW_MIN = 120;
const REFRESH_INTERVAL_MS = 20000;

// ---------- DOM ----------
const stopTitle = document.getElementById("stopTitle");
const directionTitle = document.getElementById("directionTitle");
const lineBadge = document.getElementById("lineBadge");
const clock = document.getElementById("clock");
const firstTimeBig = document.getElementById("firstTimeBig");
const firstTimeSmall = document.getElementById("firstTimeSmall");
const secondTimeBig = document.getElementById("secondTimeBig");
const secondTimeSmall = document.getElementById("secondTimeSmall");
const statusBox = document.getElementById("status");
const alertBox = document.getElementById("alertBox");

// ---------- Хранилище ----------
let stops = [];
let routes = {};
let routes2ByShort = {};
let trips = [];
let stopTimes = [];
let calendar = [];
let mergedStops = {};
let protoRoot = null;
let pendingFetchPromise = null;

// ---------- Утилиты ----------
function logStatus(t, err = false) {
  statusBox.textContent = t;
  statusBox.style.color = err ? "#b22" : "inherit";
}

function utcSecondsToLocalTimeStr(ts) {
  if (!ts || isNaN(ts)) return "—";
  return new Date(ts * 1000).toLocaleTimeString("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function minutesUntil(ts) {
  if (!ts) return null;
  const now = Math.floor(Date.now() / 1000);
  return Math.max(0, Math.round((ts - now) / 60));
}

async function loadCSV(p) {
  const r = await fetch(p);
  if (!r.ok) throw new Error("Ошибка загрузки " + p + " (" + r.status + ")");
  return Papa.parse(await r.text(), { header: true, skipEmptyLines: true }).data;
}

// ---------- Нормализация / merged stops ----------
function normalizeNameForGroup(name) {
  if (!name) return "";
  let s = name
    .replace(/\b(?:Quai|Quais|Voie|Voies|Platform|Plateforme)\b.*$/i, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\s+[A-Z0-9]{1,2}$/i, "")
    .replace(/[-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return s.replace(/\b(arrêt|station)\b/gi, "").trim();
}

function detectPlatformFromName(name) {
  if (!name) return null;
  const m = name.match(/\b(?:Quai|Voie|Platform|Plateforme)\b[^\w]*([A-Z0-9]+)\b/i) || name.match(/\b([A-Z0-9])\b$/);
  return m ? (m[1] || m[0]).toString() : null;
}

function buildMergedStops() {
  mergedStops = {};
  for (const s of stops) {
    const key = normalizeNameForGroup(s.stop_name);
    if (!key) continue;
    if (!mergedStops[key])
      mergedStops[key] = {
        baseName: s.stop_name.replace(/\s*(?:Quai|Voie|Platform|Bus|Tram).*/i, "").trim(),
        memberStopIds: [],
        platforms: new Set(),
      };
    mergedStops[key].memberStopIds.push(s.stop_id);
    const pf = detectPlatformFromName(s.stop_name) || s.platform_code || s.stop_code;
    if (pf) mergedStops[key].platforms.add(String(pf));
  }
  for (const k of Object.keys(mergedStops))
    mergedStops[k].platforms = Array.from(mergedStops[k].platforms).sort();
}

// ---------- Proto ----------
async function loadProto() {
  protoRoot = await protobuf.load(PROTO_PATH);
}

async function fetchRTandDecode() {
  if (!protoRoot) throw new Error("protoRoot не загружен");
  const r = await fetch(RT_URL);
  if (!r.ok) throw new Error("Ошибка RT " + r.status);
  const buf = await r.arrayBuffer();
  const FeedMessage = protoRoot.lookupType("transit_realtime.FeedMessage");
  const dec = FeedMessage.decode(new Uint8Array(buf));
  return FeedMessage.toObject(dec, { longs: String, enums: String, bytes: String });
}

// ---------- Загрузка GTFS ----------
async function loadGTFS() {
  logStatus("Загружаю GTFS...");
  const [stopsData, routesData, routes2Data, tripsData, stopTimesData, calendarData] = await Promise.all([
    loadCSV(GTFS_BASE + "stops.txt"),
    loadCSV(GTFS_BASE + "routes.txt"),
    loadCSV(GTFS2_BASE + "routes.txt").catch(() => []),
    loadCSV(GTFS_BASE + "trips.txt").catch(() => []),
    loadCSV(GTFS_BASE + "stop_times.txt").catch(() => []),
    loadCSV(GTFS_BASE + "calendar.txt").catch(() => []),
  ]);

  stops = stopsData;
  routes = {};
  for (const r of routesData) if (r.route_id) routes[r.route_id] = r;
  routes2ByShort = {};
  for (const r of routes2Data) if (r.route_short_name) routes2ByShort[r.route_short_name] = r;
  trips = tripsData;
  stopTimes = stopTimesData;
  calendar = calendarData;

  buildMergedStops();
  console.log("✅ GTFS загружен:", { stops: stops.length, trips: trips.length, stopTimes: stopTimes.length });
}

// ---------- Сбор отправлений ----------
async function collectDeparturesForMergedKey(keyOrStopId, platformFilterVal, windowMinutes) {
  let key = keyOrStopId;
  if (!mergedStops[key]) {
    for (const k of Object.keys(mergedStops)) {
      if (mergedStops[k].memberStopIds.includes(String(keyOrStopId))) {
        key = k;
        break;
      }
    }
  }
  const merged = mergedStops[key];
  if (!merged) return [];
  const now = Math.floor(Date.now() / 1000);
  const windowEnd = now + (windowMinutes || DEFAULT_WINDOW_MIN) * 60;
  let deps = [];

  // === RT ===
  const rtTrips = new Set();
  try {
    const feed = await fetchRTandDecode();
    if (feed.entity) {
      for (const e of feed.entity) {
        const tu = e.trip_update || e.tripUpdate;
        if (!tu) continue;
        const trip = tu.trip || tu.tripDescriptor;
        if (!trip) continue;
        const tripId = trip.trip_id;
        rtTrips.add(tripId);

        const stus = tu.stop_time_update || tu.stopTimeUpdate || [];
        for (const stu of stus) {
          const stopId = stu.stop_id || stu.stopId;
          if (!merged.memberStopIds.includes(stopId)) continue;
          const depObj = stu.departure || stu.arrival;
          const depTs = depObj ? Number(depObj.time || depObj) : null;
          if (!depTs || depTs < now || depTs > windowEnd) continue;

          let pf = stu.platform || stu.stop_platform || stu.stopPlatform;
          if (!pf) {
            const s = stops.find((x) => x.stop_id === stopId);
            if (s) pf = detectPlatformFromName(s.stop_name) || s.platform_code || s.stop_code;
          }
          if (platformFilterVal && String(pf) !== String(platformFilterVal)) continue;

          const tripRow = trips.find((t) => t.trip_id === tripId);
          const headsign = tripRow ? tripRow.trip_headsign || "" : "";

          const routeShort = trip.route_short_name || trip.routeShortName || tripRow?.route_short_name;
          const routeColor =
            (routes2ByShort[routeShort]?.route_color && "#" + routes2ByShort[routeShort].route_color) || "#333";

          deps.push({
            tripId,
            routeId: trip.route_id || trip.routeId,
            routeShort,
            headsign,
            stopId,
            platform: pf,
            departureTime: depTs,
            color: routeColor,
            source: "RT",
          });
        }
      }
    }
  } catch (e) {
    console.warn("⚠️ RT error:", e.message);
  }

  // === STATIC ===
  const nowObj = new Date();
  const secToday = nowObj.getHours() * 3600 + nowObj.getMinutes() * 60 + nowObj.getSeconds();
  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][nowObj.getDay()];
  const activeServices = calendar.filter((c) => c[weekday] === "1").map((c) => c.service_id);

  for (const st of stopTimes) {
    if (!merged.memberStopIds.includes(st.stop_id)) continue;
    const [h, m, s] = (st.departure_time || st.arrival_time || "00:00:00").split(":").map(Number);
    const sec = h * 3600 + m * 60 + (s || 0);
    if (sec < secToday || sec > secToday + windowMinutes * 60) continue;

    const trip = trips.find((t) => t.trip_id === st.trip_id && activeServices.includes(t.service_id));
    if (!trip) continue;
    if (rtTrips.has(trip.trip_id)) continue;

    const routeShort = trip.route_short_name;
    const color =
      (routes2ByShort[routeShort]?.route_color && "#" + routes2ByShort[routeShort].route_color) || "#555";

    deps.push({
      tripId: st.trip_id,
      routeId: trip.route_id,
      routeShort,
      headsign: trip.trip_headsign || "",
      stopId: st.stop_id,
      platform: stops.find((s) => s.stop_id === st.stop_id)?.platform_code || "",
      departureTime: Math.floor(now / 86400) * 86400 + sec,
      color,
      source: "GTFS",
    });
  }

  deps.sort((a, b) => a.departureTime - b.departureTime);
  return deps;
}

// ---------- UI / LOGIC: чтение параметров URL ----------
const params = new URLSearchParams(location.search);
const idParam = params.get("id") || params.get("stop") || params.get("key");
const lineParam = params.get("line") || params.get("route") || params.get("r");

function resolveMergedKey(param) {
  if (!param) return null;
  if (mergedStops[param]) return param;
  for (const k of Object.keys(mergedStops)) {
    if (mergedStops[k].memberStopIds.includes(String(param))) return k;
  }
  for (const k of Object.keys(mergedStops)) {
    if (mergedStops[k].baseName.toLowerCase().includes(String(param).toLowerCase())) return k;
  }
  return null;
}

// ---------- Отрисовка табло в стиле РАТП ----------
function renderBoardFromDeps(mergedKey, deps, preferredLine) {
  if (mergedKey && mergedStops[mergedKey]) {
    stopTitle.textContent = mergedStops[mergedKey].baseName;
  } else {
    stopTitle.textContent = idParam || "—";
  }

  let filtered = deps;
  if (preferredLine) {
    filtered = deps.filter((d) => 
      String(d.routeShort) === String(preferredLine) || 
      String(d.routeId) === String(preferredLine)
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const next = filtered
    .map(d => ({...d, minutes: minutesUntil(d.departureTime)}))
    .filter(d => d.minutes !== null && d.minutes >= 0)
    .sort((a,b) => a.departureTime - b.departureTime)
    .slice(0, 5);

  // Первое отправление
  if (next[0]) {
    const d = next[0];
    firstTimeBig.textContent = d.minutes === 0 ? "0" : `${d.minutes}`;
    
    // Ищем следующее отправление той же линии
    const nextSameLine = filtered
      .filter(x => x.routeShort === d.routeShort && x.departureTime > d.departureTime)
      .sort((a,b) => a.departureTime - b.departureTime)[0];
    
    if (nextSameLine) {
      const nextMinutes = minutesUntil(nextSameLine.departureTime);
      firstTimeSmall.textContent = `| ${nextMinutes}`;
    } else {
      firstTimeSmall.textContent = "";
    }

    lineBadge.style.background = d.color || "#f2c100";
    lineBadge.textContent = d.routeShort || d.routeId || "—";
    directionTitle.textContent = d.headsign || "";
    
    // Подсветка если меньше 2 минут
    if (d.minutes <= 2) {
      firstTimeBig.classList.add('soon');
    } else {
      firstTimeBig.classList.remove('soon');
    }
  } else {
    firstTimeBig.textContent = "--";
    firstTimeSmall.textContent = "";
    firstTimeBig.classList.remove('soon');
    lineBadge.textContent = "—";
    directionTitle.textContent = "—";
  }

  // Второе отправление (следующая линия)
  if (next[1]) {
    const d = next[1];
    secondTimeBig.textContent = d.minutes === 0 ? "0" : `${d.minutes}`;
    secondTimeSmall.textContent = "";
    
    if (d.minutes <= 2) {
      secondTimeBig.classList.add('soon');
    } else {
      secondTimeBig.classList.remove('soon');
    }
  } else {
    secondTimeBig.textContent = "--";
    secondTimeSmall.textContent = "";
    secondTimeBig.classList.remove('soon');
  }

  // Статус
  const nowTime = new Date();
  statusBox.textContent = `Actualisé à ${nowTime.toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit'})}`;
  
  // Уведомления
  if (filtered.length === 0 && preferredLine) {
    alertBox.textContent = `Aucun départ pour la ligne "${preferredLine}" dans les prochaines ${DEFAULT_WINDOW_MIN} minutes.`;
  } else {
    alertBox.textContent = "";
  }
}

// ---------- Обновление часов ----------
function updateClockUI() {
  const now = new Date();
  clock.textContent = now.toLocaleTimeString('fr-FR', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false 
  });
}

// ---------- Основная функция обновления ----------
async function refreshBoard() {
  if (!idParam) {
    logStatus("Paramètre id manquant dans l'URL (ex: ?id=nom-de-la-station ou ?id=12345)", true);
    return;
  }
  
  const mergedKey = resolveMergedKey(idParam);
  if (!mergedKey) {
    console.warn("Clé merged non trouvée, tentative avec stop_id:", idParam);
  }

  try {
    logStatus("Chargement des départs...");
    pendingFetchPromise = collectDeparturesForMergedKey(mergedKey || idParam, "", 120);
    const deps = await pendingFetchPromise;
    renderBoardFromDeps(mergedKey, deps, lineParam);
  } catch (e) {
    logStatus("Erreur: " + e.message, true);
    console.error(e);
  } finally {
    pendingFetchPromise = null;
  }
}

// ---------- Инициализация ----------
async function init() {
  try {
    await loadGTFS();
    await loadProto();
    logStatus("Prêt - chargement du tableau...");

    // Первый рендер
    await refreshBoard();

    // Часы
    setInterval(updateClockUI, 1000);
    updateClockUI();

    // Автообновление
    setInterval(() => {
      refreshBoard();
    }, REFRESH_INTERVAL_MS);
  } catch (e) {
    logStatus("Erreur d'initialisation: " + e.message, true);
    console.error(e);
  }
}

// Запуск
init();
