// main.js — версия с объединением RT + GTFS без дублей, headsign из trips.txt и цветами из gtfs2

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
let trips = [];
let stopTimes = [];
let calendar = [];
let mergedStops = {};
let protoRoot = null;
let currentMergedKey = null;
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
async function loadCSV(p) {
  const r = await fetch(p);
  if (!r.ok) throw new Error("Ошибка загрузки " + p);
  return Papa.parse(await r.text(), { header: true, skipEmptyLines: true }).data;
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

// ---------- Нормализация ----------
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

// ---------- Сбор отправлений ----------
async function collectDeparturesForMergedKey(key, platformFilterVal, windowMinutes) {
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
  for (const e of matches) {
    const d = document.createElement("div");
    d.className = "item";
    d.textContent = `${e.name} — ${e.count} ост.`;
    d.onclick = () => selectMergedKey(e.key);
    suggestionsBox.appendChild(d);
  }
});
function searchMergedStops(q) {
  q = q.toLowerCase();
  const res = [];
  for (const k of Object.keys(mergedStops))
    if (k.includes(q) || mergedStops[k].baseName.toLowerCase().includes(q))
      res.push({ key: k, name: mergedStops[k].baseName, count: mergedStops[k].memberStopIds.length });
  return res.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30);
}
function selectMergedKey(k) {
  currentMergedKey = k;
  const m = mergedStops[k];
  stopNameH2.textContent = m.baseName;
  platformFilter.innerHTML = "<option value=''>Все</option>";
  for (const p of m.platforms) {
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
function renderDepartures(d) {
  departuresList.innerHTML = "";
  if (!d.length) {
    departuresList.innerHTML = "<div class='status'>Нет доступных отправлений.</div>";
    return;
  }
  for (const x of d) {
    const div = document.createElement("div");
    div.className = "departure";

    const badge = document.createElement("div");
    badge.className = "route-badge";
    badge.style.background = x.color || "#333";
    badge.textContent = x.routeShort || x.routeId || "—";

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<div><strong>${x.headsign || "—"}</strong></div>
      <div style="color:var(--muted);font-size:13px">${x.stopId} ${x.platform ? "• платф. " + x.platform : ""}</div>
      <div style="font-size:11px;color:#888">${x.source}</div>`;

    const t = document.createElement("div");
    t.className = "time";
    t.textContent = utcSecondsToLocalTimeStr(x.departureTime);

    div.append(badge, info, t);
    departuresList.append(div);
  }
}

// ---------- Основная логика ----------
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
    await loadProto();
    logStatus("Готово — можно искать остановку.");

    refreshBtn.onclick = () => runFetchAndRender();
    platformFilter.onchange = () => runFetchAndRender();
    windowMinutesInput.onchange = () => runFetchAndRender();

    setInterval(() => {
      if (currentMergedKey) runFetchAndRender();
    }, REFRESH_INTERVAL_MS);
  } catch (e) {
    logStatus("Ошибка инициализации: " + e.message, true);
  }
}
init();
