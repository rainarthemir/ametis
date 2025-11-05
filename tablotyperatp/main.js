// ---------------------
// main.js
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

// ---------- Сбор отправлений (использован твой код почти без изменений) ----------
async function collectDeparturesForMergedKey(keyOrStopId, platformFilterVal, windowMinutes) {
  // keyOrStopId может быть merged-key или реальным stop_id
  let key = keyOrStopId;
  if (!mergedStops[key]) {
    // попробуем найти merged-key, если передан stop_id
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

          // headsign из trips.txt
          const tripRow = trips.find((t) => t.trip_id === tripId);
          const headsign = tripRow ? tripRow.trip_headsign || "" : "";

          // Цвет — по route_short_name из GTFS2
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

  // === STATIC (добавляем всё, что не покрыто RT) ===
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
    if (rtTrips.has(trip.trip_id)) continue; // не дублируем RT-трип

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

// ---------- UI / LOGIC: чтение параметров URL и рендер табло ----------
const params = new URLSearchParams(location.search);
const idParam = params.get("id") || params.get("stop") || params.get("key");
const lineParam = params.get("line") || params.get("route") || params.get("r");

// Функция: найти merged key по входному param (или вернуть null)
function resolveMergedKey(param) {
  if (!param) return null;
  if (mergedStops[param]) return param; // уже merged-key
  // если param равен stop_id
  for (const k of Object.keys(mergedStops)) {
    if (mergedStops[k].memberStopIds.includes(String(param))) return k;
  }
  // пробуем найти по частичному совпадению в baseName
  for (const k of Object.keys(mergedStops)) {
    if (mergedStops[k].baseName.toLowerCase().includes(String(param).toLowerCase())) return k;
  }
  return null;
}

function renderBoardFromDeps(mergedKey, deps, preferredLine) {
  // Заголовок станции
  if (mergedKey && mergedStops[mergedKey]) {
    stopTitle.textContent = mergedStops[mergedKey].baseName;
  } else {
    stopTitle.textContent = idParam || "—";
  }

  // Фильтрация по линии (если задан)
  let filtered = deps;
  if (preferredLine) {
    filtered = deps.filter((d) => String(d.routeShort) === String(preferredLine) || String(d.routeId) === String(preferredLine));
  }

  // Если фильтр обнулил, покажем предупреждение
  if (preferredLine && filtered.length === 0) {
    alertBox.textContent = `Нет отправлений для линии "${preferredLine}" в текущем окне времени.`;
  } else {
    alertBox.textContent = "";
  }

  // Показываем 2 ближайших
  const now = Math.floor(Date.now() / 1000);
  const next = filtered
    .map(d => ({...d, minutes: minutesUntil(d.departureTime)}))
    .filter(d => d.minutes !== null && d.minutes >= 0)
    .sort((a,b) => a.departureTime - b.departureTime)
    .slice(0, 5); // возьмём несколько, но отобразим 2

  // Заполнение первого/второго
  function fillSlot(slotIndex, slotElementBig, slotElementSmall) {
    const d = next[slotIndex];
    if (!d) {
      slotElementBig.textContent = "--";
      slotElementSmall.textContent = "—";
      return;
    }
    // большой — минуты (или "à l'instant")
    slotElementBig.textContent = d.minutes === 0 ? "À l'instant" : `${d.minutes} min`;
    // малый — направление + абсолютное время
    const tAbs = utcSecondsToLocalTimeStr(d.departureTime);
    slotElementSmall.textContent = `${d.headsign || d.routeShort || d.routeId} • ${tAbs}`;
    // поменяем бейдж цвета и direction
    lineBadge.style.background = d.color || "#f2c100";
    lineBadge.textContent = d.routeShort || d.routeId || "—";
    directionTitle.textContent = d.headsign || "";
  }

  fillSlot(0, firstTimeBig, firstTimeSmall);
  fillSlot(1, secondTimeBig, secondTimeSmall);

  // статус
  logStatus(`Найдено отправлений: ${deps.length} (после фильтра: ${filtered.length})`);
}

// Основная функция: загружает и обновляет табло
async function refreshBoard() {
  if (!idParam) {
    logStatus("Параметр id не задан в URL (пример: ?id=nom-de-la-station или ?id=12345)", true);
    return;
  }
  const mergedKey = resolveMergedKey(idParam);
  if (!mergedKey) {
    // если не нашли merged-key, попробуем считать, что idParam — stop_id, и всё равно вызовем collect
    console.warn("Merged key не найден, попытаемся использовать как stop_id:", idParam);
  }

  try {
    logStatus("Загружаю отправления...");
    pendingFetchPromise = collectDeparturesForMergedKey(mergedKey || idParam, "", 120);
    const deps = await pendingFetchPromise;
    renderBoardFromDeps(mergedKey, deps, lineParam);
  } catch (e) {
    logStatus("Ошибка: " + e.message, true);
    console.error(e);
  } finally {
    pendingFetchPromise = null;
  }
}

// clock update
function updateClockUI() {
  const now = new Date();
  clock.textContent = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
setInterval(updateClockUI, 1000);
updateClockUI();

// ---------- Инициализация ----------
async function init() {
  try {
    await loadGTFS();
    await loadProto();
    logStatus("Готово — загружаю табло...");

    // первый рендер
    await refreshBoard();

    // интервал автообновления
    setInterval(() => {
      refreshBoard();
    }, REFRESH_INTERVAL_MS);
  } catch (e) {
    logStatus("Ошибка инициализации: " + e.message, true);
    console.error(e);
  }
}
init();
