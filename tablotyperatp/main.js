// ---------------------
// main.js - RATP Board
// ---------------------

// ---------- НАСТРОЙКИ ----------
const GTFS_BASE = "../gtfs/";
const GTFS2_BASE = "../gtfs2/";
const PROTO_PATH = "../gtfs-realtime.proto";
const RT_TRIP_URL = "https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update";
const RT_ALERT_URL = "https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-alert";

const DEFAULT_WINDOW_MIN = 120;
const REFRESH_INTERVAL_MS = 20000;

// ---------- DOM ----------
const lineBadge = document.getElementById("lineBadge");
const directionTitle = document.getElementById("directionTitle");
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
let calendarDates = [];
let mergedStops = {};
let protoRoot = null;
let currentStopId = null;

// ---------- Утилиты ----------
function logStatus(t) {
  const now = new Date();
  statusBox.textContent = `Actualisé à ${now.toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit'})}`;
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

// ---------- Proto ----------
async function loadProto() {
  protoRoot = await protobuf.load(PROTO_PATH);
}

async function fetchRTandDecode(url) {
  if (!protoRoot) throw new Error("protoRoot не загружен");
  const r = await fetch(url);
  if (!r.ok) throw new Error("Ошибка RT " + r.status);
  const buf = await r.arrayBuffer();
  const FeedMessage = protoRoot.lookupType("transit_realtime.FeedMessage");
  const dec = FeedMessage.decode(new Uint8Array(buf));
  return FeedMessage.toObject(dec, { longs: String, enums: String, bytes: String });
}

// ---------- Загрузка GTFS ----------
async function loadGTFS() {
  const [stopsData, routesData, routes2Data, tripsData, stopTimesData, calendarData, calendarDatesData] = await Promise.all([
    loadCSV(GTFS_BASE + "stops.txt"),
    loadCSV(GTFS_BASE + "routes.txt"),
    loadCSV(GTFS2_BASE + "routes.txt").catch(() => []),
    loadCSV(GTFS_BASE + "trips.txt"),
    loadCSV(GTFS_BASE + "stop_times.txt"),
    loadCSV(GTFS_BASE + "calendar.txt").catch(() => []),
    loadCSV(GTFS_BASE + "calendar_dates.txt").catch(() => [])
  ]);

  stops = stopsData;
  routes = {};
  for (const r of routesData) if (r.route_id) routes[r.route_id] = r;
  
  routes2ByShort = {};
  for (const r of routes2Data) if (r.route_short_name) routes2ByShort[r.route_short_name] = r;
  
  trips = tripsData;
  stopTimes = stopTimesData;
  calendar = calendarData;
  calendarDates = calendarDatesData;

  console.log("✅ GTFS загружен:", { 
    stops: stops.length, 
    routes: routesData.length,
    trips: trips.length, 
    stopTimes: stopTimes.length 
  });
}

// ---------- Поиск активных сервисов ----------
function getActiveServiceIds() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10).replace(/-/g, '');
  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][now.getDay()];
  
  // Проверяем calendar_dates на исключения
  const exceptions = calendarDates.filter(cd => cd.date === today);
  const addedServices = new Set(exceptions.filter(cd => cd.exception_type === '1').map(cd => cd.service_id));
  const removedServices = new Set(exceptions.filter(cd => cd.exception_type === '2').map(cd => cd.service_id));
  
  // Базовые сервисы из calendar
  const baseServices = calendar.filter(c => c[weekday] === '1').map(c => c.service_id);
  
  // Применяем исключения
  const activeServices = new Set(baseServices.filter(s => !removedServices.has(s)));
  addedServices.forEach(s => activeServices.add(s));
  
  return Array.from(activeServices);
}

// ---------- Сбор отправлений ----------
async function collectDepartures(stopId, routeShortName) {
  const activeServices = getActiveServiceIds();
  const now = Math.floor(Date.now() / 1000);
  const windowEnd = now + DEFAULT_WINDOW_MIN * 60;
  
  let deps = [];

  // === RT данные ===
  try {
    const feed = await fetchRTandDecode(RT_TRIP_URL);
    if (feed.entity) {
      for (const e of feed.entity) {
        const tu = e.trip_update;
        if (!tu) continue;
        
        const trip = tu.trip;
        if (!trip) continue;
        
        const tripId = trip.trip_id;
        const routeId = trip.route_id;

        // Проверяем маршрут
        const route = routes[routeId];
        if (!route || route.route_short_name !== routeShortName) continue;

        const stus = tu.stop_time_update || [];
        for (const stu of stus) {
          const stopIdRt = stu.stop_id;
          if (stopIdRt !== stopId) continue;
          
          const depTs = stu.departure ? Number(stu.departure.time) : null;
          if (!depTs || depTs < now || depTs > windowEnd) continue;

          // Находим trip для получения headsign
          const tripInfo = trips.find(t => t.trip_id === tripId);
          if (!tripInfo) continue;

          deps.push({
            tripId,
            routeId,
            routeShort: routeShortName,
            headsign: tripInfo.trip_headsign || "",
            stopId: stopIdRt,
            departureTime: depTs,
            source: "RT",
          });
        }
      }
    }
  } catch (e) {
    console.warn("⚠️ RT error:", e.message);
  }

  // === Статические данные (дополняем RT) ===
  const nowObj = new Date();
  const secToday = nowObj.getHours() * 3600 + nowObj.getMinutes() * 60 + nowObj.getSeconds();
  
  // Находим stop_times для этой остановки
  const relevantStopTimes = stopTimes.filter(st => st.stop_id === stopId);
  
  for (const st of relevantStopTimes) {
    const [h, m, s] = (st.departure_time || "00:00:00").split(":").map(Number);
    const sec = h * 3600 + m * 60 + (s || 0);
    if (sec < secToday || sec > secToday + DEFAULT_WINDOW_MIN * 60) continue;

    const trip = trips.find(t => t.trip_id === st.trip_id && activeServices.includes(t.service_id));
    if (!trip) continue;
    
    const route = routes[trip.route_id];
    if (!route || route.route_short_name !== routeShortName) continue;
    
    // Проверяем, нет ли уже этого trip в RT данных
    if (deps.some(d => d.tripId === trip.trip_id)) continue;

    deps.push({
      tripId: trip.trip_id,
      routeId: trip.route_id,
      routeShort: routeShortName,
      headsign: trip.trip_headsign || "",
      stopId: stopId,
      departureTime: Math.floor(now / 86400) * 86400 + sec,
      source: "GTFS",
    });
  }

  // Сортируем по времени отправления
  deps.sort((a, b) => a.departureTime - b.departureTime);
  return deps;
}

// ---------- Загрузка alerts ----------
async function loadAlerts() {
  try {
    const feed = await fetchRTandDecode(RT_ALERT_URL);
    const alerts = [];
    
    if (feed.entity) {
      for (const e of feed.entity) {
        const alert = e.alert;
        if (alert && alert.header_text) {
          // Берем французский перевод
          const translation = alert.header_text.translation.find(t => t.language === 'fr') || 
                             alert.header_text.translation[0];
          if (translation) {
            alerts.push(translation.text);
          }
        }
      }
    }
    
    return alerts;
  } catch (e) {
    console.warn("⚠️ Alerts error:", e.message);
    return [];
  }
}

// ---------- Поиск остановки по имени ----------
function findStopByName(stopName) {
  const normalized = stopName.toLowerCase().trim();
  return stops.find(stop => 
    stop.stop_name.toLowerCase().includes(normalized)
  );
}

// ---------- Отрисовка табло ----------
function renderBoard(deps, alerts, routeShortName, stopName) {
  // Устанавливаем номер линии и цвет
  lineBadge.textContent = routeShortName;
  lineBadge.className = `line-badge line-${routeShortName}`;

  const now = Math.floor(Date.now() / 1000);
  const nextDeps = deps
    .map(d => ({...d, minutes: minutesUntil(d.departureTime)}))
    .filter(d => d.minutes !== null && d.minutes >= 0)
    .slice(0, 3);

  // Первое отправление
  if (nextDeps[0]) {
    const d = nextDeps[0];
    firstTimeBig.textContent = d.minutes === 0 ? "0" : `${d.minutes}`;
    directionTitle.textContent = d.headsign || stopName || "Direction inconnue";
    
    // Следующее отправление той же линии
    const nextSameLine = nextDeps[1];
    if (nextSameLine) {
      firstTimeSmall.textContent = `| ${nextSameLine.minutes}`;
    } else {
      firstTimeSmall.textContent = "";
    }

    if (d.minutes <= 2) {
      firstTimeBig.classList.add('soon');
    } else {
      firstTimeBig.classList.remove('soon');
    }
  } else {
    firstTimeBig.textContent = "--";
    firstTimeSmall.textContent = "";
    firstTimeBig.classList.remove('soon');
    directionTitle.textContent = stopName || "Aucun départ";
  }

  // Второе отправление
  if (nextDeps[1]) {
    const d = nextDeps[1];
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

  // Alerts
  if (alerts.length > 0) {
    alertBox.textContent = alerts[0];
  } else {
    alertBox.textContent = "Trafic normal sur toutes les lignes";
  }

  logStatus();
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
  const params = new URLSearchParams(location.search);
  const stopParam = params.get("stop") || "Gare d'Amiens";
  const lineParam = params.get("line") || "T1";
  
  try {
    // Находим остановку
    const stop = findStopByName(stopParam);
    if (!stop) {
      console.error("Остановка не найдена:", stopParam);
      return;
    }
    
    currentStopId = stop.stop_id;
    
    const [deps, alerts] = await Promise.all([
      collectDepartures(currentStopId, lineParam),
      loadAlerts()
    ]);
    
    renderBoard(deps, alerts, lineParam, stop.stop_name);
  } catch (e) {
    console.error("Erreur:", e);
    alertBox.textContent = "Erreur de chargement des données";
  }
}

// ---------- Инициализация ----------
async function init() {
  try {
    await loadGTFS();
    await loadProto();
    
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
    console.error("Erreur d'initialisation:", e);
    alertBox.textContent = "Erreur d'initialisation";
  }
}

// Запуск
init();
