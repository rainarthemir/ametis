// ---------------------
// main.js - RATP Board
// ---------------------

// ---------- НАСТРОЙКИ ----------
const GTFS_BASE = "../gtfs/";
const GTFS2_BASE = "../gtfs2/";
const PROTO_PATH = "../gtfs-realtime.proto";
const RT_TRIP_URL = "https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update";
const RT_ALERT_URL = "https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-alerts";

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
  const processedTrips = new Set();

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
            continue;
          }

          // Проверяем, не обрабатывали ли мы уже этот рейс
          if (processedTrips.has(tripId)) {
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
          
          processedTrips.add(tripId);
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
    
    processedTrips.add(trip.trip_id);
  }

  // Сортируем по времени отправления и убираем дубликаты по tripId
  deps.sort((a, b) => a.departureTime - b.departureTime);
  
  // Дополнительная фильтрация дубликатов
  const uniqueDeps = [];
  const seenTripIds = new Set();
  
  for (const dep of deps) {
    if (!seenTripIds.has(dep.tripId)) {
      uniqueDeps.push(dep);
      seenTripIds.add(dep.tripId);
    }
  }
  
  console.log("📋 Все отправления после фильтрации:", uniqueDeps.map(d => ({
    source: d.source,
    headsign: d.headsign,
    minutes: minutesUntil(d.departureTime),
    time: new Date(d.departureTime * 1000).toLocaleTimeString()
  })));
  
  return uniqueDeps;
}

// ---------- Получение алертов с сайта Ametis ----------
async function loadAlertsFromWebsite() {
  try {
    console.log("🌐 Загрузка алертов с сайта Ametis...");
    
    // Пробуем разные CORS proxy
    const proxies = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent('https://www.plan.ametis.fr/fr/traffic-infos')}`,
      `https://corsproxy.io/?${encodeURIComponent('https://www.plan.ametis.fr/fr/traffic-infos')}`,
      `https://proxy.cors.sh/${encodeURIComponent('https://www.plan.ametis.fr/fr/traffic-infos')}`,
      'https://www.plan.ametis.fr/fr/traffic-infos' // Прямой запрос (может не работать из-за CORS)
    ];
    
    let response = null;
    let lastError = null;
    
    // Пробуем каждый proxy по очереди
    for (const proxyUrl of proxies) {
      try {
        console.log(`🔄 Пробуем proxy: ${proxyUrl.substring(0, 50)}...`);
        response = await fetch(proxyUrl, {
          method: 'GET',
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });
        
        if (response.ok) {
          console.log(`✅ Proxy успешен: ${proxyUrl.substring(0, 50)}...`);
          break;
        } else {
          console.warn(`❌ Proxy не сработал: ${response.status}`);
          lastError = new Error(`HTTP ${response.status}`);
        }
      } catch (error) {
        console.warn(`❌ Ошибка proxy: ${error.message}`);
        lastError = error;
        continue;
      }
    }
    
    if (!response || !response.ok) {
      throw lastError || new Error('Все proxy не сработали');
    }

    const html = await response.text();
    
    // Проверяем, что получили HTML, а не ошибку
    if (!html || html.includes('error') || html.length < 100) {
      throw new Error('Неверный HTML ответ');
    }
    
    // Создаем временный DOM для парсинга
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    const alertsData = { 'en_cours': [], 'a_venir': [] };
    
    // Упрощенный парсинг - ищем любые элементы с алертами
    const alertElements = doc.querySelectorAll('[class*="alert"], [class*="Alert"], [class*="disruption"], [class*="Disruption"]');
    
    console.log(`🔍 Найдено элементов алертов: ${alertElements.length}`);
    
    // Если нашли элементы алертов, пробуем извлечь текст
    if (alertElements.length > 0) {
      alertElements.forEach((element, index) => {
        try {
          const text = element.textContent.trim();
          if (text && text.length > 10 && !text.includes('JavaScript') && !text.includes('cookie')) {
            // Определяем тип алерта по контексту
            const isToCome = text.toLowerCase().includes('venir') || 
                            text.toLowerCase().includes('prévu') ||
                            element.closest('[id*="ToCome"], [class*="ToCome"]');
            
            if (isToCome) {
              alertsData.a_venir.push({
                line_id: null,
                line_number: null,
                mode: null,
                direction: null,
                message: text.substring(0, 200) // Ограничиваем длину
              });
            } else {
              alertsData.en_cours.push({
                line_id: null,
                line_number: null,
                mode: null,
                direction: null,
                message: text.substring(0, 200)
              });
            }
          }
        } catch (error) {
          console.warn(`Ошибка обработки элемента алерта ${index}:`, error);
        }
      });
    }
    
    // Если не нашли алертов через парсинг, используем fallback сообщения
    if (alertsData.en_cours.length === 0 && alertsData.a_venir.length === 0) {
      console.log("ℹ️ Алерты не найдены через парсинг, используем fallback");
      // Можно добавить тестовые алерты для демонстрации
      alertsData.en_cours.push({
        line_id: 'line:AMI:T1-1',
        line_number: 'T1',
        mode: 'TRAM',
        direction: 'OUTWARD',
        message: 'Trafic normal sur toutes les lignes'
      });
    }
    
    console.log("✅ Алерты обработаны:", {
      en_cours: alertsData.en_cours.length,
      a_venir: alertsData.a_venir.length
    });
    
    return alertsData;
    
  } catch (error) {
    console.error("❌ Ошибка загрузки алертов с сайта:", error);
    // Возвращаем пустые алерты вместо выброса ошибки
    return { 'en_cours': [], 'a_venir': [] };
  }
}

// ---------- Обновленная функция загрузки алертов ----------
async function loadAlerts() {
  try {
    // Сначала пробуем загрузить с сайта Ametis
    const websiteAlerts = await loadAlertsFromWebsite();
    
    // Форматируем алерты для отображения
    const displayAlerts = [];
    
    // Добавляем текущие алерты
    if (websiteAlerts.en_cours.length > 0) {
      websiteAlerts.en_cours.forEach(alert => {
        const lineInfo = alert.line_number ? `Ligne ${alert.line_number} - ` : '';
        const message = alert.message || 'Information trafic';
        displayAlerts.push(`${lineInfo}${message}`);
      });
    }
    
    // Добавляем предстоящие алерты
    if (websiteAlerts.a_venir.length > 0) {
      websiteAlerts.a_venir.forEach(alert => {
        const message = alert.message || 'Travaux à venir';
        displayAlerts.push(`[À venir] ${message}`);
      });
    }
    
    // Если алертов нет, возвращаем стандартное сообщение
    if (displayAlerts.length === 0) {
      return ["Trafic normal sur toutes les lignes"];
    }
    
    console.log("🔔 Алерты для отображения:", displayAlerts);
    return displayAlerts;
    
  } catch (error) {
    console.warn("⚠️ Ошибка загрузки алертов:", error);
    return ["Trafic normal sur toutes les lignes"];
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
  const nextDeps = deps
    .map(d => ({...d, minutes: minutesUntil(d.departureTime)}))
    .filter(d => d.minutes !== null && d.minutes >= 0 && d.minutes <= 120) // Фильтруем реальные времена
    .slice(0, 3); // Берем максимум 3 для отображения

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
    if (alerts.length > 0 && alerts[0] !== "Trafic normal sur toutes les lignes") {
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
