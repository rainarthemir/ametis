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
let previousAlertsHash = null; // Для сравнения алертов

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
      stopTimes: stopTimes.length,
      calendar: calendar.length,
      calendarDates: calendarDates.length
    });
    
  } catch (error) {
    console.error("❌ Ошибка загрузки GTFS:", error);
    throw error;
  }
}

// ---------- Fallback функция если calendar недоступен ----------
function getAllServiceIds() {
  const allServices = new Set();
  trips.forEach(t => allServices.add(t.service_id));
  return Array.from(allServices);
}

// ---------- Поиск активных сервисов ----------
function getActiveServiceIds() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10).replace(/-/g, '');
  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][now.getDay()];
  
  console.log("📅 Поиск активных сервисов для:", { today, weekday });
  
  // Если calendar не загружен, возвращаем все сервисы
  if (!calendar || calendar.length === 0) {
    console.log("⚠️ calendar не загружен - предполагаем что все сервисы активны");
    return getAllServiceIds();
  }
  
  const addedServices = new Set();
  const removedServices = new Set();
  
  // Обрабатываем calendar_dates если доступен
  if (calendarDates && calendarDates.length > 0) {
    const exceptions = calendarDates.filter(cd => cd.date === today);
    console.log("📋 Исключения на сегодня:", exceptions.length);
    
    exceptions.forEach(cd => {
      if (cd.exception_type === '1') {
        addedServices.add(cd.service_id);
        console.log("➕ Добавлен сервис через calendar_dates:", cd.service_id);
      } else if (cd.exception_type === '2') {
        removedServices.add(cd.service_id);
        console.log("➖ Удален сервис через calendar_dates:", cd.service_id);
      }
    });
  } else {
    console.log("ℹ️ calendar_dates не загружен или пуст");
  }
  
  // Базовые сервисы из calendar
  const baseServices = calendar.filter(c => {
    // Проверяем день недели
    if (c[weekday] !== '1') {
      return false;
    }
    
    // Проверяем период действия
    try {
      const startDate = new Date(
        parseInt(c.start_date.slice(0,4)),
        parseInt(c.start_date.slice(4,6)) - 1,
        parseInt(c.start_date.slice(6,8))
      );
      const endDate = new Date(
        parseInt(c.end_date.slice(0,4)),
        parseInt(c.end_date.slice(4,6)) - 1,
        parseInt(c.end_date.slice(6,8))
      );
      endDate.setHours(23, 59, 59, 999); // Конец дня
      
      const isInRange = now >= startDate && now <= endDate;
      return isInRange;
    } catch (e) {
      console.warn("⚠️ Ошибка парсинга дат для сервиса:", c.service_id, e);
      return false;
    }
  }).map(c => c.service_id);
  
  console.log("📊 Базовые сервисы из calendar:", baseServices.length);
  
  // Объединяем результаты
  const activeServices = new Set();
  
  // Добавляем базовые сервисы, кроме удаленных
  baseServices.forEach(s => {
    if (!removedServices.has(s)) {
      activeServices.add(s);
    } else {
      console.log("🚫 Базовый сервис удален через calendar_dates:", s);
    }
  });
  
  // Добавляем сервисы из исключений
  addedServices.forEach(s => {
    activeServices.add(s);
    console.log("✅ Сервис добавлен через calendar_dates:", s);
  });
  
  const result = Array.from(activeServices);
  console.log("🎯 Итоговые активные сервисы:", { 
    базовые: baseServices.length,
    добавлено: addedServices.size,
    удалено: removedServices.size,
    итого: result.length
  });
  
  // Логируем несколько примеров для проверки
  if (result.length > 0) {
    console.log("📝 Примеры активных сервисов:", result.slice(0, 5));
  }
  
  return result;
}

// ---------- Сбор отправлений ----------
async function collectDepartures(stopId, routeShortName) {
  const activeServices = getActiveServiceIds();
  const now = Math.floor(Date.now() / 1000);
  const windowEnd = now + DEFAULT_WINDOW_MIN * 60;
  
  let deps = [];

  console.log("🔍 Поиск отправлений для остановки:", stopId, "линия:", routeShortName);
  console.log("📅 Активных сервисов:", activeServices.length);

  // === RT данные (реальное время) ===
  try {
    const feed = await fetchRTandDecode(RT_TRIP_URL);
    console.log("📡 RT данные получены, entities:", feed.entity?.length || 0);
    
    if (feed.entity && feed.entity.length > 0) {
      const rtTrips = new Set();
      let processedEntities = 0;
      let skippedByRoute = 0;
      let skippedByService = 0;
      let skippedByStop = 0;
      let skippedByTime = 0;
      let foundStops = 0;
      
      for (const e of feed.entity) {
        processedEntities++;
        const tu = e.trip_update;
        if (!tu) continue;
        
        const trip = tu.trip;
        if (!trip) continue;
        
        const tripId = trip.trip_id;
        const routeId = trip.route_id;

        // Проверяем маршрут
        const route = routes[routeId];
        if (!route) {
          console.log("🚫 Маршрут не найден в GTFS для route_id:", routeId);
          skippedByRoute++;
          continue;
        }
        if (route.route_short_name !== routeShortName) {
          console.log("🚫 Маршрут не совпадает:", route.route_short_name, "ожидался:", routeShortName);
          skippedByRoute++;
          continue;
        }

        // Находим trip для получения service_id
        const tripInfo = trips.find(t => t.trip_id === tripId);
        if (!tripInfo) {
          console.log("❌ Trip не найден в GTFS:", tripId);
          continue;
        }
        
        // ВАЖНО: проверяем активен ли сервис для этого трипа
        if (!activeServices.includes(tripInfo.service_id)) {
          console.log("🚫 Пропускаем RT trip - неактивный сервис:", tripId, "service_id:", tripInfo.service_id);
          skippedByService++;
          continue;
        }

        const stus = tu.stop_time_update || [];
        console.log(`🔎 Обрабатываем trip ${tripId}, stop_time_updates:`, stus.length);
        
        let stopProcessed = false;
        for (const stu of stus) {
          const stopIdRt = stu.stop_id;
          console.log("  🔍 Проверяем stop_id:", stopIdRt, "ожидаемый:", stopId, "совпадение:", stopIdRt === stopId);
          
          if (stopIdRt !== stopId) {
            skippedByStop++;
            continue;
          }
          
          foundStops++;
          const depObj = stu.departure || stu.arrival;
          if (!depObj) {
            console.log("  ❌ Нет departure/arrival времени");
            continue;
          }
          
          const depTs = Number(depObj.time);
          console.log("  ⏰ Время отправления:", depTs, "timestamp:", new Date(depTs * 1000).toISOString());
          console.log("  📅 Текущее время:", now, "timestamp:", new Date(now * 1000).toISOString());
          console.log("  🪟 Окно до:", windowEnd, "timestamp:", new Date(windowEnd * 1000).toISOString());
          
          if (!depTs) {
            console.log("  ❌ Неверное время отправления");
            continue;
          }
          if (depTs < now) {
            console.log("  🚫 Время отправления уже прошло");
            skippedByTime++;
            continue;
          }
          if (depTs > windowEnd) {
            console.log("  🚫 Время отправления за пределами окна");
            skippedByTime++;
            continue;
          }

          // ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ - ДОБАВЛЯЕМ ОТПРАВЛЕНИЕ
          console.log("  ✅ ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ! Добавляем отправление");
          
          deps.push({
            tripId,
            routeId,
            routeShort: routeShortName,
            headsign: tripInfo.trip_headsign || "",
            stopId: stopIdRt,
            departureTime: depTs,
            source: "RT",
            serviceId: tripInfo.service_id
          });
          
          rtTrips.add(tripId);
          stopProcessed = true;
          console.log("  ✅ Добавлено RT отправление:", {
            tripId,
            headsign: tripInfo.trip_headsign,
            time: new Date(depTs * 1000).toLocaleTimeString(),
            minutes: minutesUntil(depTs)
          });
          break; // Прерываем цикл по stop_time_update для этого trip
        }
        
        if (!stopProcessed && stus.length > 0) {
          console.log("  ❗ Trip имеет stop_time_updates, но ни один не подошел для нашей остановки");
        }
      }
      
      console.log("📊 Детальная статистика RT обработки:", {
        обработано_entities: processedEntities,
        пропущено_маршрут: skippedByRoute,
        пропущено_сервис: skippedByService,
        пропущено_остановка: skippedByStop,
        пропущено_время: skippedByTime,
        найдено_совпадений_остановок: foundStops,
        найдено_отправлений: deps.length
      });
      
      // Дополнительная отладка: покажем какие stop_id вообще есть в RT данных для нашего маршрута
      const allStopIdsInRT = new Set();
      feed.entity.forEach(e => {
        const tu = e.trip_update;
        if (!tu) return;
        
        const routeId = tu.trip?.route_id;
        if (!routeId) return;
        
        const route = routes[routeId];
        if (!route || route.route_short_name !== routeShortName) return;
        
        const stus = tu.stop_time_update || [];
        stus.forEach(stu => {
          if (stu.stop_id) allStopIdsInRT.add(stu.stop_id);
        });
      });
      
      console.log("🔍 Все stop_id в RT данных для маршрута", routeShortName + ":", Array.from(allStopIdsInRT));
      console.log("🎯 Наш целевой stop_id:", stopId);
      
      console.log("✅ RT данные обработаны, найдено отправлений:", deps.length);
    }
  } catch (e) {
    console.warn("⚠️ RT error:", e.message);
  }

  // === Статические данные (теоретическое расписание) ===
  // Используем всегда, но если есть RT, то дополняем ими
  console.log("🔄 Используем теоретическое расписание");
  
  const nowObj = new Date();
  const secToday = nowObj.getHours() * 3600 + nowObj.getMinutes() * 60 + nowObj.getSeconds();
  
  // Находим stop_times для этой остановки и маршрута
  const relevantStopTimes = stopTimes.filter(st => {
    if (st.stop_id !== stopId) return false;
    
    const trip = trips.find(t => t.trip_id === st.trip_id);
    if (!trip) return false;
    
    // ПРОВЕРЯЕМ АКТИВНЫЙ СЕРВИС!
    if (!activeServices.includes(trip.service_id)) {
      return false;
    }
    
    const route = routes[trip.route_id];
    return route && route.route_short_name === routeShortName;
  });
  
  console.log("📊 Найдено stop_times с активными сервисами:", relevantStopTimes.length);
  
  // Группируем stop_times по времени и направлению
  const timeHeadsignMap = new Map();
  
  for (const st of relevantStopTimes) {
    const [h, m, s] = (st.departure_time || st.arrival_time || "00:00:00").split(":").map(Number);
    const sec = h * 3600 + m * 60 + (s || 0);
    
    // Проверяем время (в пределах 2 часов)
    if (sec < secToday || sec > secToday + DEFAULT_WINDOW_MIN * 60) continue;

    const trip = trips.find(t => t.trip_id === st.trip_id);
    if (!trip) continue;
    
    const route = routes[trip.route_id];
    if (!route || route.route_short_name !== routeShortName) continue;

    const headsign = trip.trip_headsign || "";
    
    // Создаем ключ: время + направлению
    const key = `${sec}_${headsign}`;
    
    // Если для этого времени и направления еще нет trip'а, добавляем
    if (!timeHeadsignMap.has(key)) {
      // Вычисляем timestamp для статического времени
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const baseTime = Math.floor(todayStart.getTime() / 1000);
      const departureTime = baseTime + sec;

      timeHeadsignMap.set(key, {
        tripId: trip.trip_id,
        routeId: trip.route_id,
        routeShort: routeShortName,
        headsign: headsign,
        stopId: stopId,
        departureTime: departureTime,
        source: "GTFS",
        serviceId: trip.service_id
      });
    }
  }
  
  // Преобразуем Map в массив и добавляем к существующим отправлениям
  const staticDeps = Array.from(timeHeadsignMap.values());
  console.log("📋 Уникальные теоретические отправления:", staticDeps.length);
  
  // Объединяем с RT отправлениями
  deps = [...deps, ...staticDeps];

  // Сортируем по времени отправления
  deps.sort((a, b) => a.departureTime - b.departureTime);
  
  // Убираем дубликаты по tripId
  const uniqueDeps = [];
  const seenTrips = new Set();
  
  deps.forEach(dep => {
    if (!seenTrips.has(dep.tripId)) {
      seenTrips.add(dep.tripId);
      uniqueDeps.push(dep);
    }
  });
  
  console.log("🎯 Финальные отправления:", uniqueDeps.map(d => ({
    tripId: d.tripId,
    source: d.source,
    serviceId: d.serviceId,
    headsign: d.headsign,
    minutes: minutesUntil(d.departureTime),
    time: new Date(d.departureTime * 1000).toLocaleTimeString()
  })));
  
  return uniqueDeps;
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

// ---------- Получение номера линии из line_id ----------
function getLineNumberFromId(lineId) {
  if (!lineId) return null;
  
  // Извлекаем часть между AMI- и следующим -
  const match = lineId.match(/AMI-([^-]+)-/);
  if (match && match[1]) {
    return match[1]; // Возвращаем как есть: L, 5A, 5B, N2 и т.д.
  }
  
  return null;
}

// ---------- Получение цвета линии ТОЛЬКО из GTFS2 ----------
function getLineColor(lineNumber) {
  if (!lineNumber) return '#666666';
  
  // Ищем в GTFS2 по полному номеру линии (L, 5A, 5B, N2 и т.д.)
  const lineData = routes2ByShort[lineNumber];
  if (lineData && lineData.route_color) {
    return '#' + lineData.route_color;
  }
  
  // Если не нашли в GTFS2, используем серый по умолчанию
  return '#666666';
}

// ---------- Очистка текста алерта с поддержкой HTML ----------
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
    // Заменяем обратные слеши с n на настоящие переносы строк
    .replace(/\\n/g, '\n')
    // Убираем множественные пробелы и табы
    .replace(/[ \t]+/g, ' ')
    // Разделяем на строки и очищаем каждую
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0) // Убираем пустые строки
    .join('\n')
    .trim();
}

// ---------- Группировка одинаковых алертов ----------
function groupAlerts(alerts) {
  const grouped = new Map();
  
  alerts.forEach(alert => {
    if (!alert.message) return;
    
    const cleanMessage = cleanAlertText(alert.message);
    
    // Всегда используем line_id для получения номера линии
    const lineNumber = getLineNumberFromId(alert.line_id);
    
    if (!cleanMessage) return;
    
    // Создаем ключ для группировки по сообщению
    const key = cleanMessage;
    
    if (!grouped.has(key)) {
      grouped.set(key, {
        message: cleanMessage,
        lineNumbers: new Set(),
        lineColors: new Map(),
        originalAlerts: []
      });
    }
    
    const group = grouped.get(key);
    
    // Добавляем номер линии если он есть
    if (lineNumber) {
      group.lineNumbers.add(lineNumber);
      // Сохраняем цвет для этой линии ТОЛЬКО из GTFS2
      const lineColor = getLineColor(lineNumber);
      group.lineColors.set(lineNumber, lineColor);
    }
    
    // Сохраняем оригинальный алерт для отладки
    group.originalAlerts.push(alert);
  });
  
  // Преобразуем в массив для отображения
  return Array.from(grouped.values()).map(group => {
    const lineNumbers = Array.from(group.lineNumbers);
    const lineColors = Array.from(group.lineColors.entries());
    
    return {
      message: group.message,
      lineNumbers: lineNumbers,
      lineColors: lineColors,
      // Для обратной совместимости оставляем первый номер линии
      lineNumber: lineNumbers.length > 0 ? lineNumbers[0] : null,
      lineColor: lineColors.length > 0 ? lineColors[0][1] : '#666666',
      count: group.originalAlerts.length
    };
  });
}

// ---------- Форматирование сообщения алерта ----------
function formatAlertMessage(alert) {
  if (!alert.message) return null;
  
  const cleanMessage = cleanAlertText(alert.message);
  const lineNumbers = alert.lineNumbers || [alert.lineNumber];
  const lineColors = alert.lineColors || [[alert.lineNumber, alert.lineColor]];
  
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
    lineNumbers: lineNumbers,
    lineColors: lineColors,
    title: title,
    description: description,
    fullMessage: cleanMessage,
    count: alert.count || 1
  };
}

// ---------- Создание HTML для алерта ----------
function createAlertHTML(alertData) {
  if (!alertData) return '';
  
  // Создаем бейджи для всех линий
  const lineBadgesHTML = alertData.lineNumbers && alertData.lineNumbers.length > 0 
    ? alertData.lineNumbers.map((lineNumber, index) => {
        // Находим правильный цвет для этой линии
        const lineColorEntry = alertData.lineColors.find(([num]) => num === lineNumber);
        const lineColor = lineColorEntry ? lineColorEntry[1] : getLineColor(lineNumber);
        
        return `<div class="alert-line-badge" style="background: ${lineColor}">${lineNumber}</div>`;
      }).join('')
    : '';
  
  const titleHTML = alertData.title ? 
    `<div class="alert-title">${alertData.title}</div>` : '';
  
  const descriptionHTML = alertData.description ? 
    `<div class="alert-description">${alertData.description}</div>` : '';
  
  return `
    ${lineBadgesHTML ? `<div class="alert-line-badges">${lineBadgesHTML}</div>` : ''}
    <div class="alert-content">
      ${titleHTML}
      ${descriptionHTML}
    </div>
  `;
}

// ---------- Запуск карусели алертов ----------
function startAlertCarousel(alerts) {
  // Создаем хэш текущих алертов для сравнения
  const currentAlertsHash = JSON.stringify(alerts);
  
  // Если алерты не изменились, не перезапускаем карусель
  if (currentAlertsHash === previousAlertsHash) {
    console.log("🔔 Алерты не изменились, сохраняем карусель");
    return;
  }
  
  // Сохраняем новый хэш
  previousAlertsHash = currentAlertsHash;
  
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
    
    // Обрабатываем текущие алерты (en_cours)
    if (websiteAlerts.en_cours && websiteAlerts.en_cours.length > 0) {
      // Группируем одинаковые алерты
      const groupedCurrentAlerts = groupAlerts(websiteAlerts.en_cours);
      
      groupedCurrentAlerts.forEach(alert => {
        const formattedAlert = formatAlertMessage(alert);
        if (formattedAlert) {
          displayAlerts.push(formattedAlert);
        }
      });
    }
    
    // Обрабатываем предстоящие алерты (a_venir), исключая "Aucune perturbation"
    if (websiteAlerts.a_venir && websiteAlerts.a_venir.length > 0) {
      const upcomingAlerts = websiteAlerts.a_venir.filter(alert => 
        alert.message && 
        !alert.message.includes("Aucune perturbation de ligne à venir") &&
        !alert.message.includes("Aucune perturbation")
      );
      
      if (upcomingAlerts.length > 0) {
        // Группируем одинаковые алерты
        const groupedUpcomingAlerts = groupAlerts(upcomingAlerts);
        
        groupedUpcomingAlerts.forEach(alert => {
          const formattedAlert = formatAlertMessage(alert);
          if (formattedAlert) {
            formattedAlert.title = `[À venir] ${formattedAlert.title}`;
            displayAlerts.push(formattedAlert);
          }
        });
      }
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
    lineBadge.style.color = '#fff';
  }

  const now = Math.floor(Date.now() / 1000);
  
  // Фильтруем отправления
  const nextDeps = deps
    .map(d => ({...d, minutes: minutesUntil(d.departureTime)}))
    .filter(d => d.minutes !== null && d.minutes >= 0 && d.minutes <= 120)
    .slice(0, 2); // Берем только 2 отправления

  console.log("📊 Отфильтрованные отправления:", nextDeps);

  // Первое отправление
  if (firstTimeBig) {
    if (nextDeps[0]) {
      const d = nextDeps[0];
      firstTimeBig.textContent = d.minutes === 0 ? "0" : `${d.minutes}`;
      
      if (directionTitle) {
        directionTitle.textContent = d.headsign || stopName || "Direction inconnue";
      }
    } else {
      firstTimeBig.textContent = "--";
      if (directionTitle) directionTitle.textContent = stopName || "Aucun départ";
    }
  }

  // Второе отправление
  if (secondTimeBig) {
    if (nextDeps[1]) {
      const d = nextDeps[1];
      secondTimeBig.textContent = d.minutes === 0 ? "0" : `${d.minutes}`;
    } else {
      secondTimeBig.textContent = "--";
    }
  }

  // Убираем отображение второго времени (small time)
  if (firstTimeSmall) firstTimeSmall.textContent = "";
  if (secondTimeSmall) secondTimeSmall.textContent = "";

  // Alerts
  if (alertBox) {
    if (alerts && alerts.length > 0) {
      startAlertCarousel(alerts);
    } else {
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
    
    // Гарантируем, что часы всегда поверх других элементов
    clock.style.zIndex = '1000';
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
