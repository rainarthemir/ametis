// импорт твоих функций из основного проекта можно сделать напрямую
// здесь я беру из твоего же main.js подходы (loadGTFS, fetchRTandDecode и т.п.)

const params = new URLSearchParams(location.search);
const stopIdParam = params.get("id");
const lineParam = params.get("line");

const stopTitle = document.getElementById("stopTitle");
const lineBadge = document.getElementById("lineBadge");
const firstTime = document.getElementById("firstTime");
const secondTime = document.getElementById("secondTime");
const alertBox = document.getElementById("alertBox");
const clock = document.getElementById("clock");

function updateClock() {
  const now = new Date();
  clock.textContent = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
setInterval(updateClock, 1000);
updateClock();

// Тут можно использовать твои существующие функции, но если хочешь отдельно:
async function loadData() {
  await loadGTFS();
  await loadProto();

  const deps = await collectDeparturesForMergedKey(stopIdParam, "", 30);
  const filtered = lineParam
    ? deps.filter(d => d.routeShort === lineParam || d.routeId === lineParam)
    : deps;

  renderBoard(filtered);
}

function renderBoard(deps) {
  stopTitle.textContent = mergedStops[stopIdParam]?.baseName || stopIdParam;
  if (deps.length) {
    const color = deps[0].color || "#f2c100";
    lineBadge.style.background = color;
    lineBadge.textContent = deps[0].routeShort || lineParam || "M?";
  }

  const now = Math.floor(Date.now() / 1000);
  const sorted = deps
    .map(d => Math.max(0, Math.round((d.departureTime - now) / 60)))
    .filter(m => m >= 0)
    .slice(0, 2);

  firstTime.textContent = sorted[0] !== undefined ? sorted[0] : "--";
  secondTime.textContent = sorted[1] !== undefined ? sorted[1] : "--";

  // Сообщение (пример, можно подставлять любое событие)
  alertBox.innerHTML = `
    <strong>⚠️ Info trafic:</strong> Certaines stations peuvent être fermées.
  `;
}

loadData().catch(e => {
  alertBox.textContent = "Erreur: " + e.message;
});
