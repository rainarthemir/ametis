// main.js — улучшенный вариант для группировки и полного списка отправлений

// ---------- НАСТРОЙКИ ----------
const GTFS_BASE = "../gtfs/";
const GTFS2_BASE = "../gtfs2/";
const PROTO_PATH = "../gtfs-realtime.proto";
const RT_URL = "https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update";

const DEFAULT_WINDOW_MIN = 120;
const REFRESH_INTERVAL_MS = 20000;

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
let stopTimes = [];
let trips = [];
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

function safeGet(obj, ...path) {
  return path.reduce(
    (acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined),
    obj
  );
}

function loadCSV(path) {
  return fetch(path)
    .then(r => {
      if (!r.ok) throw new Error("Ошибка загрузки " + path);
      return r.text();
    })
    .then(txt => Papa.parse(txt, { header: true, skipEmptyLines: true }).data);
}

// ---------- Загрузка GTFS ----------
async function loadGTFS() {
  logStatus("Загружаю GTFS...");
  const [stopsData, routesData, routes2Data, stopTimesData, tripsData] = await Promise.all([
    loadCSV(GTFS_BASE + "stops.txt"),
    loadCSV(GTFS_BASE + "routes.txt"),
    loadCSV(GTFS2_BASE + "routes.txt").catch(() => []),
    loadCSV(GTFS_BASE + "stop_times.txt").catch(() => []),
    loadCSV(GTFS_BASE + "trips.txt").catch(() => []),
  ]);
  stops = stopsData;
  stopTimes = stopTimesData;
  trips = tripsData;

  routes = {};
  for (const r of routesData) if (r.route_id) routes[r.route_id] = r;

  routes2ByShort = {};
  for (const r of routes2Data)
    if (r.route_short_name) routes2ByShort[r.route_short_name] = r;

  logStatus(
    `GTFS загружен: stops=${stops.length}, stop_times=${stopTimes.length}, trips=${trips.length}`
  );
}

// ---------- Объединение остановок ----------
function normalizeNameForGroup(name) {
  if (!name) return "";
  return name
    .replace(/\s*[-–—]\s*/g, " ")
    .replace(/\b(?:Quai|Quais|Voie|Platform|Plateforme|Bus|Tram|Train|Métro|Metro)\b[^\n,]*/gi, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

// ---------- Поиск ----------
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
  res.sort((a, b) => a.name.localeCompare(b.name));
  return res.slice(0, 30);
}

// ---------- Proto ----------
async function loadProto() {
  protoRoot = await protobuf.load(PROTO_PATH);
}

// ---------- Реальное время ----------
async function fetchRTandDecode() {
  if (!protoRoot) throw new Error("protoRoot не загружен");
  const r = await fetch(RT_URL);
  if (!r.ok) throw new Error("Ошибка RT " + r.status);
  const buffer = await r.arrayBuffer();
  const FeedMessage = protoRoot.lookupType("transit_realtime.FeedMessage");
  const decoded = FeedMessage.decode(new Uint8Array(buffer));
  return FeedMessage.toObject(decoded, { longs: String, enums: String, bytes: String });
}

// ---------- Отправления ----------
async function collectDeparturesForMergedKey(key, platformFilterVal, windowMinutes) {
  const merged = mergedStops[key];
  if (!merged) return [];
  const now = Math.floor(Date.now() / 1000);
  const windowEnd = now + (windowMinutes || DEFAULT_WINDOW_MIN) * 60;
  let departures = [];

  try {
    const feed = await fetchRTandDecode();
    if (feed.entity && Array.isArray(feed.entity)) {
      for (const ent of feed.entity) {
        const tripUpdate = ent.trip_update || ent.tripUpdate;
        if (!tripUpdate) continue;
        const trip = tripUpdate.trip || tripUpdate.tripDescriptor;
        if (!trip) continue;

        const stus = tripUpdate.stop_time_update || tripUpdate.stopTimeUpdate || [];
        for (const stu of stus) {
          const stopId = stu.stop_id || stu.stopId;
          if (!merged.memberStopIds.includes(stopId)) continue;

          const depObj = stu.departure || stu.departure_time || stu.arrival || stu.arrival_time;
          const depTs = depObj ? Number(depObj.time || depObj) : null;
          if (!depTs || depTs < now || depTs > windowEnd) continue;

          let platform =
            stu.platform || stu.stop_platform || stu.stopPlatform || null;
          if (!platform) {
            const s = stops.find(x => x.stop_id === stopId);
            if (s)
              platform =
                detectPlatformFromName(s.stop_name) ||
                s.platform_code ||
                s.stop_code;
          }
          if (platformFilterVal && String(platform) !== String(platformFilterVal)) continue;

          const routeId = trip.route_id || trip.routeId;
          const routeShort = trip.route_short_name || trip.routeShortName;
          const routeObj = routes[routeId] || {};
          const color =
            (routeObj.route_color && "#" + routeObj.route_color) ||
            (routes2ByShort[routeShort]?.route_color && "#" + routes2ByShort[routeShort].route_color) ||
            "#333";

          const headsign = trip.trip_headsign || trip.tripHeadsign || "";

          departures.push({
            tripId: trip.trip_id,
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
    }
  } catch (e) {
    console.warn("RT feed error:", e.message);
  }

  // ---------- fallback: если RT пуст, подставляем теоретические из stop_times ----------
  if (departures.length === 0 && stopTimes.length) {
    const todaySec = now % 86400;
    for (const st of stopTimes) {
      if (!merged.memberStopIds.includes(st.stop_id)) continue;
      const [h, m, s] = (st.departure_time || st.arrival_time || "00:00:00").split(":").map(Number);
      const sec = h * 3600 + m * 60 + (s || 0);
      if (sec < todaySec || sec > todaySec + (windowMinutes * 60)) continue;

      const trip = trips.find(t => t.trip_id === st.trip_id);
      const route = trip ? routes[trip.route_id] : {};
      const color = route?.route_color ? "#" + route.route_color : "#555";

      departures.push({
        tripId: st.trip_id,
        routeId: trip?.route_id,
        routeShort: route?.route_short_name,
        headsign: trip?.trip_headsign || "",
        stopId: st.stop_id,
        platform: stops.find(s => s.stop_id === st.stop_id)?.platform_code || "",
        departureTime: (Math.floor(Date.now() / 1000 / 86400) * 86400) + sec,
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
  if (!matches.length) {
    suggestionsBox.innerHTML = "<div class='item'>Совпадений не найдено</div>";
    return;
  }
  for (const m of matches) {
    const div = document.createElement("div");
    div.className = "item";
    div.textContent = `${m.name} (${m.count})`;
    div.onclick = () => selectMergedKey(m.key);
    suggestionsBox.appendChild(div);
  }
});

function selectMergedKey(key) {
  currentMergedKey = key;
  const merged = mergedStops[key];
  stopNameH2.textContent = merged.baseName;
  platformFilter.innerHTML = `<option value="">Все</option>`;
  for (const p of merged.platforms) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = p;
    platformFilter.appendChild(o);
  }
  selectedArea.classList.remove("hidden");
  suggestionsBox.innerHTML = "";
  runFetchAndRender();
}

// ---------- Отрисовка ----------
function renderDepartures(deps) {
  departuresList.innerHTML = "";
  if (!deps.length) {
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
                      <div style="color:var(--muted);font-size:13px">${d.stopId} ${d.platform ? "• платф. " + d.platform : ""}</div>`;

    const timeDiv = document.createElement("div");
    timeDiv.className = "time";
    timeDiv.textContent = utcSecondsToLocalTimeStr(d.departureTime);

    div.append(badge, info, timeDiv);
    departuresList.append(div);
  }
}

// ---------- Логика ----------
async function runFetchAndRender() {
  if (!currentMergedKey || pendingFetchPromise) return;
  const platformVal = platformFilter.value || "";
  const minutes = parseInt(windowMinutesInput.value || DEFAULT_WINDOW_MIN, 10);
  try {
    logStatus("Загружаю отправления...");
    pendingFetchPromise = collectDeparturesForMergedKey(currentMergedKey, platformVal, minutes);
    const deps = await pendingFetchPromise;
    renderDepartures(deps);
    logStatus(`Найдено отправлений: ${deps.length}`);
  } catch (e) {
    logStatus("Ошибка: " + e.message, true);
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

    refreshBtn.onclick = () => runFetchAndRender();
    platformFilter.onchange = () => runFetchAndRender();
    windowMinutesInput.onchange = () => runFetchAndRender();

    liveTimer = setInterval(() => {
      if (currentMergedKey) runFetchAndRender();
    }, REFRESH_INTERVAL_MS);
  } catch (e) {
    logStatus("Ошибка инициализации: " + e.message, true);
  }
}

init();
