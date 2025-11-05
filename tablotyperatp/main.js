// ---------------------
// main.js - RATP Board
// ---------------------

// ---------- НАСТРОЙКИ ----------
const GTFS_BASE = "../gtfs/";
const GTFS2_BASE = "../gtfs2/";
const PROTO_PATH = "../gtfs-realtime.proto";
const RT_TRIP_URL = "https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update";
const RT_ALERT_URL = "https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-alerts"; // Исправленная ссылка

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
let protoRoot = null;
let currentStopId = null;

// ---------- Утилиты ----------
function logStatus() {
  if (statusBox) {
    const now = new Date();
    statusBox.textContent = `Actualisé à ${now.toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit'})}`;
  }
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
  try {
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
    
  } catch (error) {
    console.error("❌ Ошибка загрузки GTFS:", error);
    throw error;
  }
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
  const processedTrips = new Set(); // Для отслеживания уже обработанных рейсов

  // === RT данные ===
  try {
    const feed = await fetchRTandDecode(RT_TRIP_URL);
    console.log("📡 RT данные получены, entities:", feed.entity?.length || 0);
    
    if (feed.entity) {
      for (const e of feed.entity) {
        const tu = e.trip_update;
        if (!tu) continue;
        
        const trip = tu.trip;
        if (!trip) continue;
        
        const tripId = trip.trip_id;
        const routeId = trip.route_id;

        // Проверяем маршрут - ищем по route_id в routes
        const route = routes[routeId];
        if (!route) {
          console.log("⚠️ Маршрут не найден в GTFS:", routeId);
          continue;
        }
        
        if (route.route_short_name !== routeShortName) continue;

        const stus = tu.stop_time_update || [];
        for (const stu of stus) {
          const stopIdRt = stu.stop_id;
          if (stopIdRt !== stopId) continue;
          
          // Используем departure.time если есть, иначе arrival.time
          const depObj = stu.departure || stu.arrival;
          if (!depObj) continue;
          
          const depTs = Number(depObj.time);
          if (!depTs || depTs < now || depTs > windowEnd) continue;

          // Находим trip для получения headsign
          const tripInfo = trips.find(t => t.trip_id === tripId);
          if (!tripInfo) {
            console.log("⚠️ Trip не найден:", tripId);
            continue;
          }

          // Проверяем, не обрабатывали ли мы уже этот рейс
          if (processedTrips.has(tripId)) {
            console.log("⚠️ Дубликат рейса в RT, пропускаем:", tripId);
            continue;
          }

          deps.push({
            tripId,
            routeId,
            routeShort: routeShortName,
            headsign: tripInfo.trip_headsign || "",
            stopId: stopIdRt,
            departureTime: depTs,
            source: "RT",
          });
          
          processedTrips.add(tripId); // Помечаем рейс как обработанный
          
          console.log("✅ RT отправление:", { 
            tripId, 
            headsign: tripInfo.trip_headsign,
            time: new Date(depTs * 1000).toLocaleTimeString(),
            minutes: minutesUntil(depTs)
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
  
  // Находим stop_times для этой остановки и маршрута
  const relevantStopTimes = stopTimes.filter(st => {
    if (st.stop_id !== stopId) return false;
    
    const trip = trips.find(t => t.trip_id === st.trip_id);
    if (!trip) return false;
    
    const route = routes[trip.route_id];
    return route && route.route_short_name === routeShortName;
  });
  
  console.log("📊 Найдено stop_times:", relevantStopTimes.length, "для остановки", stopId);
  
  for (const st of relevantStopTimes) {
    const [h, m, s] = (st.departure_time || "00:00:00").split(":").map(Number);
    const sec = h * 3600 + m * 60 + (s || 0);
    
    // Проверяем время (в пределах 2 часов)
    if (sec < secToday || sec > secToday + DEFAULT_WINDOW_MIN * 60) continue;

    const trip = trips.find(t => t.trip_id === st.trip_id && activeServices.includes(t.service_id));
    if (!trip) continue;
    
    const route = routes[trip.route_id];
    if (!route || route.route_short_name !== routeShortName) continue;
    
    // Проверяем, нет ли уже этого trip в RT данных
    if (processedTrips.has(trip.trip_id)) {
      console.log("ℹ️ Trip уже в RT, пропускаем в GTFS:", trip.trip_id);
      continue;
    }

    // Вычисляем timestamp для статического времени
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const baseTime = Math.floor(todayStart.getTime() / 1000);
    const departureTime = baseTime + sec;

    deps.push({
      tripId: trip.trip_id,
      routeId: trip.route_id,
      routeShort: routeShortName,
      headsign: trip.trip_headsign || "",
      stopId: stopId,
      departureTime: departureTime,
      source: "GTFS",
    });
    
    processedTrips.add(trip.trip_id); // Помечаем рейс как обработанный
    
    console.log("✅ GTFS отправление:", { 
      tripId: trip.trip_id,
      headsign: trip.trip_headsign,
      time: st.departure_time,
      minutes: minutesUntil(departureTime)
    });
  }

  // Сортируем по времени отправления
  deps.sort((a, b) => a.departureTime - b.departureTime);
  
  console.log("📋 Все отправления:", deps.map(d => ({
    source: d.source,
    headsign: d.headsign,
    minutes: minutesUntil(d.departureTime),
    time: new Date(d.departureTime * 1000).toLocaleTimeString()
  })));
  
  return deps;
}

// ---------- Загрузка alerts ----------
async function loadAlerts() {
  try {
    const feed = await fetchRTandDecode(RT_ALERT_URL);
    const alerts = [];
    
    console.log("🔔 Получены данные alerts:", feed);
    
    if (feed.entity) {
      for (const e of feed.entity) {
        const alert = e.alert;
        if (alert) {
          console.log("🔔 Alert найден:", alert);
          
          // Пробуем получить текст из header_text
          if (alert.header_text) {
            const translation = alert.header_text.translation?.find(t => t.language === 'fr') || 
                               alert.header_text.translation?.[0];
            if (translation && translation.text) {
              alerts.push(translation.text);
              console.log("🔔 Alert text (header):", translation.text);
              continue;
            }
          }
          
          // Пробуем получить текст из description_text
          if (alert.description_text) {
            const translation = alert.description_text.translation?.find(t => t.language === 'fr') || 
                               alert.description_text.translation?.[0];
            if (translation && translation.text) {
              alerts.push(translation.text);
              console.log("🔔 Alert text (description):", translation.text);
              continue;
            }
          }
          
          // Если есть просто текст без переводов
          if (alert.header_text && typeof alert.header_text === 'string') {
            alerts.push(alert.header_text);
            console.log("🔔 Alert text (raw header):", alert.header_text);
          } else if (alert.description_text && typeof alert.description_text === 'string') {
            alerts.push(alert.description_text);
            console.log("🔔 Alert text (raw description):", alert.description_text);
          }
        }
      }
    }
    
    return alerts.length > 0 ? alerts : ["Trafic normal sur toutes les lignes"];
  } catch (e) {
    console.warn("⚠️ Alerts error:", e.message);
    return ["Information trafic temporairement indisponible"];
  }
}

// ---------- Поиск остановки по ID или имени ----------
function findStop(identifier) {
  if (!identifier) return null;
  
  console.log("🔍 Поиск остановки:", identifier);
  
  // Сначала ищем по stop_id (точное совпадение)
  const byId = stops.find(stop => stop.stop_id === identifier);
  if (byId) {
    console.log("✅ Найдено по ID:", byId.stop_name);
    return byId;
  }
  
  // Затем ищем по stop_code (точное совпадение)
  const byCode = stops.find(stop => stop.stop_code === identifier);
  if (byCode) {
    console.log("✅ Найдено по code:", byCode.stop_name);
    return byCode;
  }
  
  // Затем ищем по имени (частичное совпадение)
  const normalized = identifier.toLowerCase().trim();
  const byName = stops.find(stop => 
    stop.stop_name && stop.stop_name.toLowerCase().includes(normalized)
  );
  
  if (byName) {
    console.log("✅ Найдено по имени:", byName.stop_name);
    return byName;
  }
  
  console.log("❌ Остановка не найдена:", identifier);
  console.log("📋 Доступные остановки:", stops.slice(0, 5).map(s => ({
    id: s.stop_id,
    code: s.stop_code,
    name: s.stop_name
  })));
  
  return null;
}

// ---------- Отрисовка табло ----------
function renderBoard(deps, alerts, routeShortName, stopName) {
  console.log("🎨 Отрисовка табло:", { 
    отправлений: deps.length, 
    уведомлений: alerts.length, 
    линия: routeShortName, 
    остановка: stopName 
  });

  // Устанавливаем номер линии и цвет
  if (lineBadge) {
    lineBadge.textContent = routeShortName;
    lineBadge.className = `line-badge line-${routeShortName}`;
  }

  const now = Math.floor(Date.now() / 1000);
  
  // Фильтруем отправления: убираем дубликаты и нереальные времена
  const uniqueDeps = [];
  const seenTrips = new Set();
  
  for (const dep of deps) {
    // Пропускаем дубликаты по trip_id
    if (seenTrips.has(dep.tripId)) {
      console.log("🚫 Пропускаем дубликат trip:", dep.tripId);
      continue;
    }
    
    const minutes = minutesUntil(dep.departureTime);
    
    // Пропускаем нереальные времена (больше 2 часов)
    if (minutes === null || minutes > 120) {
      console.log("🚫 Пропускаем нереальное время:", minutes, "минут");
      continue;
    }
    
    uniqueDeps.push({...dep, minutes});
    seenTrips.add(dep.tripId);
  }
  
  // Сортируем по времени
  uniqueDeps.sort((a, b) => a.departureTime - b.departureTime);
  
  // Берем только первые 2 отправления для отображения
  const nextDeps = uniqueDeps.slice(0, 2);
  
  console.log("📊 Отфильтрованные отправления:", nextDeps);

  // Первое отправление
  if (firstTimeBig) {
    if (nextDeps[0]) {
      const d = nextDeps[0];
      firstTimeBig.textContent = d.minutes === 0 ? "0" : `${d.minutes}`;
      
      if (directionTitle) {
        directionTitle.textContent = d.headsign || stopName || "Direction inconnue";
      }
      
      // Следующее отправление той же линии (второе в списке)
      if (firstTimeSmall && nextDeps[1]) {
        firstTimeSmall.textContent = `| ${nextDeps[1].minutes}`;
      } else if (firstTimeSmall) {
        firstTimeSmall.textContent = "";
      }

      if (d.minutes <= 2) {
        firstTimeBig.classList.add('soon');
      } else {
        firstTimeBig.classList.remove('soon');
      }
    } else {
      firstTimeBig.textContent = "--";
      if (firstTimeSmall) firstTimeSmall.textContent = "";
      firstTimeBig.classList.remove('soon');
      if (directionTitle) directionTitle.textContent = stopName || "Aucun départ";
    }
  }

  // Второе отправление
  if (secondTimeBig) {
    if (nextDeps[1]) {
      const d = nextDeps[1];
      secondTimeBig.textContent = d.minutes === 0 ? "0" : `${d.minutes}`;
      if (secondTimeSmall) secondTimeSmall.textContent = "";
      
      if (d.minutes <= 2) {
        secondTimeBig.classList.add('soon');
      } else {
        secondTimeBig.classList.remove('soon');
      }
    } else {
      secondTimeBig.textContent = "--";
      if (secondTimeSmall) secondTimeSmall.textContent = "";
      secondTimeBig.classList.remove('soon');
    }
  }

  // Alerts
  if (alertBox) {
    if (alerts.length > 0) {
      alertBox.textContent = alerts[0];
      console.log("🔔 Alert отображен:", alerts[0]);
    } else {
      alertBox.textContent = "Trafic normal sur toutes les lignes";
    }
  }

  logStatus();
}

// ---------- Обновление часов ----------
function updateClockUI() {
  if (clock) {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('fr-FR', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    });
  }
}

// ---------- Основная функция обновления ----------
async function refreshBoard() {
  const params = new URLSearchParams(location.search);
  const stopParam = params.get("stop") || params.get("id");
  const lineParam = params.get("line") || params.get("route");
  
  console.log("🔄 Обновление табло:", { stopParam, lineParam });
  
  if (!stopParam || !lineParam) {
    console.error("❌ Необходимы параметры stop и line");
    if (alertBox) alertBox.textContent = "Paramètres STOP et LINE requis dans l'URL";
    return;
  }
  
  try {
    // Находим остановку
    const stop = findStop(stopParam);
    if (!stop) {
      console.error("❌ Остановка не найдена:", stopParam);
      if (alertBox) alertBox.textContent = `Arrêt "${stopParam}" non trouvé`;
      return;
    }
    
    currentStopId = stop.stop_id;
    console.log("📍 Остановка найдена:", { 
      name: stop.stop_name, 
      id: stop.stop_id,
      code: stop.stop_code 
    });
    
    const [deps, alerts] = await Promise.all([
      collectDepartures(currentStopId, lineParam),
      loadAlerts()
    ]);
    
    console.log("📦 Данные загружены:", { 
      отправлений: deps.length, 
      уведомлений: alerts.length
    });
    
    renderBoard(deps, alerts, lineParam, stop.stop_name);
  } catch (e) {
    console.error("❌ Ошибка:", e);
    if (alertBox) alertBox.textContent = "Erreur de chargement des données";
  }
}

// ---------- Инициализация ----------
async function init() {
  try {
    console.log("🚀 Инициализация табло RATP...");
    
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
    
    console.log("✅ Табло RATP инициализировано");
  } catch (e) {
    console.error("❌ Ошибка инициализации:", e);
    if (alertBox) alertBox.textContent = "Erreur d'initialisation du système";
  }
}

// Запуск при загрузке страницы
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
