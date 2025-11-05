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

// ---------- Карусель алертов ----------
let currentAlertIndex = 0;
let alertCarouselInterval = null;
let currentAlerts = [];

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

          // Создаем ключ для проверки дубликатов (время + направление)
          const duplicateKey = `${depTs}_${tripInfo.trip_headsign}`;
          
          // Проверяем, не обрабатывали ли мы уже этот рейс ИЛИ рейс с таким же временем и направлением
          if (processedTrips.has(tripId) || processedTrips.has(duplicateKey)) {
            console.log("🚫 Пропускаем дубликат:", { tripId, duplicateKey });
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
          processedTrips.add(duplicateKey); // Защита от дубликатов с разными tripId но одинаковым временем+направлением
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
    
    // Вычисляем timestamp для статического времени
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const baseTime = Math.floor(todayStart.getTime() / 1000);
    const departureTime = baseTime + sec;

    // Создаем ключ для проверки дубликатов (время + направление)
    const duplicateKey = `${departureTime}_${trip.trip_headsign}`;
    
    // Проверяем, нет ли уже этого trip в RT данных ИЛИ рейса с таким же временем и направлением
    if (processedTrips.has(trip.trip_id) || processedTrips.has(duplicateKey)) {
      console.log("🚫 Пропускаем статический дубликат:", { 
        tripId: trip.trip_id, 
        duplicateKey 
      });
      continue;
    }

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
    processedTrips.add(duplicateKey);
  }

  // Сортируем по времени отправления
  deps.sort((a, b) => a.departureTime - b.departureTime);
  
  console.log("📋 Финальные отправления:", deps.map(d => ({
    source: d.source,
    headsign: d.headsign,
    minutes: minutesUntil(d.departureTime),
    time: new Date(d.departureTime * 1000).toLocaleTimeString()
  })));
  
  return deps;
}

// ---------- Получение алертов через Cloudflare Worker ----------
async function loadAlertsFromWebsite() {
  try {
    console.log("🌐 Загрузка алертов через Cloudflare Worker...");
    
    const response = await fetch('https://ametisfr.dmytrothemir.workers.dev/', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const alertsData = await response.json();
    
    console.log("✅ Алерты получены через Worker:", {
      en_cours: alertsData.en_cours?.length || 0,
      a_venir: alertsData.a_venir?.length || 0
    });
    
    return alertsData;
    
  } catch (error) {
    console.error("❌ Ошибка загрузки алертов через Worker:", error);
    
    // Fallback: попробуем использовать CORS proxy
    try {
      console.log("🔄 Пробуем CORS proxy...");
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent('https://ametisfr.dmytrothemir.workers.dev/')}`;
      const response = await fetch(proxyUrl);
      
      if (response.ok) {
        const alertsData = await response.json();
        console.log("✅ Алерты получены через CORS proxy");
        return alertsData;
      }
    } catch (proxyError) {
      console.error("❌ CORS proxy тоже не сработал:", proxyError);
    }
    
    // Возвращаем структуру по умолчанию при ошибке
    return { 
      'en_cours': [], 
      'a_venir': [] 
    };
  }
}

// ---------- Получение цвета линии из GTFS2 ----------
function getLineColor(lineNumber) {
  if (!lineNumber) return '#666666'; // Серый по умолчанию
  
  const lineData = routes2ByShort[lineNumber];
  if (lineData && lineData.route_color) {
    return '#' + lineData.route_color;
  }
  
  // Цвета по умолчанию для разных типов линий
  const defaultColors = {
    'T1': '#0066CC', 'T2': '#0066CC', // Трамваи - синий
    'N1': '#993399', 'N2': '#993399', // Ночные - фиолетовый
    '1': '#FF0000', '2': '#0066CC', '3': '#009900', '4': '#FF6600', '5': '#990099',
    '6': '#66CC00', '7': '#FFCC00', '8': '#CC0066', '9': '#996633', '10': '#0099CC'
  };
  
  return defaultColors[lineNumber] || '#666666';
}

// ---------- Очистка текста алерта ----------
function cleanAlertText(text) {
  if (!text) return '';
  
  return text
    // Заменяем HTML-entities
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    // Убираем множественные пробелы
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Форматирование сообщения алерта ----------
function formatAlertMessage(alert) {
  if (!alert.message) return null;
  
  const cleanMessage = cleanAlertText(alert.message);
  const lineNumber = alert.line_number;
  const lineColor = getLineColor(lineNumber);
  
  // Разделяем сообщение на части по переносам строк
  const parts = cleanMessage.split('\n').filter(part => part.trim());
  
  let title = '';
  let description = '';
  
  if (parts.length === 1) {
    // Если только одна часть
    title = parts[0];
  } else if (parts.length >= 2) {
    // Первая строка - заголовок, остальные - описание
    title = parts[0];
    description = parts.slice(1).join('\n');
  }
  
  return {
    lineNumber: lineNumber,
    lineColor: lineColor,
    title: title,
    description: description,
    fullMessage: cleanMessage
  };
}

// ---------- Создание HTML для алерта ----------
function createAlertHTML(alertData) {
  if (!alertData) return '';
  
  const lineBadgeHTML = alertData.lineNumber ? 
    `<div class="alert-line-badge" style="background: ${alertData.lineColor}">
      ${alertData.lineNumber}
    </div>` : '';
  
  const titleHTML = alertData.title ? 
    `<div class="alert-title">${alertData.title}</div>` : '';
  
  const descriptionHTML = alertData.description ? 
    `<div class="alert-description">${alertData.description}</div>` : '';
  
  return `
    ${lineBadgeHTML}
    <div class="alert-content">
      ${titleHTML}
      ${descriptionHTML}
    </div>
  `;
}

// ---------- Запуск карусели алертов ----------
function startAlertCarousel(alerts) {
  // Останавливаем предыдущую карусель
  if (alertCarouselInterval) {
    clearInterval(alertCarouselInterval);
    alertCarouselInterval = null;
  }
  
  currentAlerts = alerts;
  currentAlertIndex = 0;
  
  // Если алертов нет или только один, не запускаем карусель
  if (!currentAlerts.length) {
    if (alertBox) {
      alertBox.innerHTML = '<div class="alert-normal">Trafic normal sur toutes les lignes</div>';
    }
    return;
  }
  
  if (currentAlerts.length === 1) {
    if (alertBox) {
      alertBox.innerHTML = createAlertHTML(currentAlerts[0]);
    }
    return;
  }
  
  // Функция для показа алерта по индексу
  function showAlert(index) {
    if (!alertBox || !currentAlerts[index]) return;
    
    alertBox.innerHTML = createAlertHTML(currentAlerts[index]);
    
    // Добавляем индикатор прогресса карусели
    const progressHTML = `
      <div class="alert-progress">
        ${currentAlerts.map((_, i) => 
          `<div class="alert-progress-dot ${i === index ? 'active' : ''}"></div>`
        ).join('')}
      </div>
    `;
    alertBox.insertAdjacentHTML('beforeend', progressHTML);
  }
  
  // Показываем первый алерт
  showAlert(0);
  
  // Запускаем карусель - переключаем каждые 10 секунд
  alertCarouselInterval = setInterval(() => {
    currentAlertIndex = (currentAlertIndex + 1) % currentAlerts.length;
    showAlert(currentAlertIndex);
  }, 10000);
}

// ---------- Обновленная функция загрузки алертов ----------
async function loadAlerts() {
  try {
    // Загружаем через Cloudflare Worker
    const websiteAlerts = await loadAlertsFromWebsite();
    
    // Форматируем алерты для отображения
    const displayAlerts = [];
    
    // Добавляем текущие алерты (en_cours)
    if (websiteAlerts.en_cours && websiteAlerts.en_cours.length > 0) {
      websiteAlerts.en_cours.forEach(alert => {
        const formattedAlert = formatAlertMessage(alert);
        if (formattedAlert) {
          displayAlerts.push(formattedAlert);
        }
      });
    }
    
    // Добавляем предстоящие алерты (a_venir), исключая "Aucune perturbation"
    if (websiteAlerts.a_venir && websiteAlerts.a_venir.length > 0) {
      websiteAlerts.a_venir.forEach(alert => {
        if (alert.message && 
            !alert.message.includes("Aucune perturbation de ligne à venir") &&
            !alert.message.includes("Aucune perturbation")) {
          const formattedAlert = formatAlertMessage(alert);
          if (formattedAlert) {
            formattedAlert.title = `[À venir] ${formattedAlert.title}`;
            displayAlerts.push(formattedAlert);
          }
        }
      });
    }
    
    // Если алертов нет, возвращаем null для стандартного сообщения
    if (displayAlerts.length === 0) {
      return null;
    }
    
    console.log("🔔 Алерты для отображения:", displayAlerts);
    return displayAlerts;
    
  } catch (error) {
    console.warn("⚠️ Ошибка загрузки алертов:", error);
    return null;
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
    уведомлений: alerts ? alerts.length : 0, 
    линия: routeShortName, 
    остановка: stopName 
  });

  // Устанавливаем номер линии и цвет
  if (lineBadge) {
    lineBadge.textContent = routeShortName;
    const lineColor = getLineColor(routeShortName);
    lineBadge.style.background = lineColor;
    
    // Всегда используем белый текст для бейджа линии
    lineBadge.style.color = '#fff';
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
    if (alerts && alerts.length > 0) {
      // Запускаем карусель алертов
      startAlertCarousel(alerts);
    } else {
      // Останавливаем карусель если она была запущена
      if (alertCarouselInterval) {
        clearInterval(alertCarouselInterval);
        alertCarouselInterval = null;
      }
      alertBox.innerHTML = '<div class="alert-normal">Trafic normal sur toutes les lignes</div>';
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
      уведомлений: alerts ? alerts.length : 0
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
