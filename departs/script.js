const gtfsUrl = "../gtfs/";
const gtfs2Url = "../gtfs2/";
const realtimeUrl = "https://proxy.transport.data.gouv.fr/resource/ametis-amiens-gtfs-rt-trip-update";

// Простейший кэш для данных
let stops = [];
let routes = {};
let routes2 = {};

async function loadGTFSData() {
  const stopsText = await fetch(gtfsUrl + "stops.txt").then(r => r.text());
  const routesText = await fetch(gtfsUrl + "routes.txt").then(r => r.text());
  const routes2Text = await fetch(gtfs2Url + "routes.txt").then(r => r.text());

  stops = parseCSV(stopsText);
  routes = indexByKey(parseCSV(routesText), "route_id");
  routes2 = indexByKey(parseCSV(routes2Text), "route_id");

  console.log("GTFS data loaded", stops.length, "stops");
}

function parseCSV(text) {
  const [headerLine, ...lines] = text.trim().split("\n");
  const headers = headerLine.split(",");
  return lines.map(line => {
    const values = line.split(",");
    const obj = {};
    headers.forEach((h, i) => obj[h] = values[i]);
    return obj;
  });
}

function indexByKey(arr, key) {
  const map = {};
  for (const item of arr) {
    map[item[key]] = item;
  }
  return map;
}

// объединение похожих остановок
function normalizeStopName(name) {
  return name.replace(/\s+Quai\s+[A-Z]/i, "").trim().toLowerCase();
}

// фильтрация и объединение остановок
function getUniqueStops() {
  const map = {};
  for (const stop of stops) {
    const norm = normalizeStopName(stop.stop_name);
    if (!map[norm]) map[norm] = [];
    map[norm].push(stop);
  }
  return map;
}

// Автопоиск по названию остановки
document.getElementById("stop").addEventListener("input", e => {
  const q = e.target.value.toLowerCase();
  const suggestions = document.getElementById("suggestions");
  suggestions.innerHTML = "";

  if (q.length < 2) return;

  const uniqueStops = getUniqueStops();
  for (const [norm, group] of Object.entries(uniqueStops)) {
    if (norm.includes(q)) {
      const li = document.createElement("li");
      li.textContent = group[0].stop_name.replace(/Quai.*/, "").trim();
      li.onclick = () => {
        showDepartures(group);
        suggestions.innerHTML = "";
        e.target.value = li.textContent;
      };
      suggestions.appendChild(li);
    }
  }
});

// Загрузка данных GTFS-RT
async function showDepartures(stopGroup) {
  const realtimeResponse = await fetch(realtimeUrl);
  const realtimeData = await realtimeResponse.arrayBuffer();

  // Для упрощения: не парсим бинарный GTFS-RT (protobuf),
  // а просто показываем уведомление (нужно использовать protobuf.js)
  const container = document.getElementById("results");
  container.innerHTML = `
    <p><b>Arrêts sélectionnés:</b> ${stopGroup.map(s => s.stop_name).join(", ")}</p>
    <p>Les données temps réel doivent être décodées à partir de gtfs-realtime.proto (non fait ici).</p>
  `;
}

// Старт
loadGTFSData();
