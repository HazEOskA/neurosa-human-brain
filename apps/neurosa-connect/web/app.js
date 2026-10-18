"use strict";

const el = (id) => document.getElementById(id);
const tabs = [...document.querySelectorAll("[role=tab]")];
let format = "mcp";
let state = null;
let pair = null;
let busy = false;
let testId = null;
let configText = "";

async function api(path, body) {
  const response = await fetch(`/connect/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    credentials: "same-origin",
    redirect: "error",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.message || "Nie udało się wykonać operacji");
    error.status = response.status;
    throw error;
  }
  return result;
}

function badge(label, type = "") {
  const node = el("connection-status");
  node.className = `status-chip ${type}`;
  node.replaceChildren(document.createElement("i"), document.createTextNode(label));
}

function controls() {
  const packageNeeded = format !== "python";
  el("pair-button").disabled = busy || !state?.ready || (packageNeeded && !state.packageAvailable);
  el("test-button").disabled = busy || !state?.ready;
  el("copy-config").disabled = busy;
  el("download-config").disabled = busy;
}

function presence() {
  if (!pair) return;
  const seen = state?.activeAgents?.find((agent) => agent.connectionId === pair.connectionId);
  const node = el("agent-presence");
  node.className = seen ? "presence connected" : "presence";
  const expired = Date.parse(pair.expiresAt) <= Date.now();
  const label = seen
    ? `Agent ${pair.agentId} potwierdził połączenie (${new Date(seen.lastSeen).toLocaleTimeString("pl-PL")})`
    : expired
      ? "Kod wygasł. Przygotuj nowe połączenie."
      : "Konfiguracja gotowa — oczekiwanie na pierwszy odczyt agenta";
  node.replaceChildren(document.createElement("i"), document.createTextNode(label));
  el("pair-expiry").textContent = seen
    ? "Połączenie potwierdzone"
    : expired
      ? "Kod wygasł"
      : `Kod ważny do ${new Date(pair.expiresAt).toLocaleTimeString("pl-PL")}`;
}

async function refresh() {
  try {
    state = await api("state");
    badge("NeurOSA odpowiada");
    el("access-message").hidden = true;
    el("brain-label").textContent = `${state.brainId} / ${state.scope.namespace}`;
  } catch (error) {
    state = null;
    badge(error.status === 401 ? "Prywatne połączenie" : "Pamięć niedostępna", "pending");
    el("access-message").hidden = false;
    el("access-message").textContent =
      error.status === 401
        ? "Otwórz prywatny link operatora, aby podłączyć agenta i wykonać test."
        : "NeurOSA nie potwierdziła dostępności. Zwykła rozmowa agenta może trwać dalej; pamięć wróci po przywróceniu połączenia.";
  }
  controls();
  presence();
}

function pythonPrefix() {
  return `import os\nos.environ["NEUROSA_CONNECTOR_URL"] = ${JSON.stringify(pair.connectorUrl)}\nos.environ["NEUROSA_PAIR_CODE"] = ${JSON.stringify(pair.pairingCode)}\nos.environ["NEUROSA_AGENT_ID"] = ${JSON.stringify(pair.agentId)}\n`;
}

function renderConfig() {
  const hints = {
    mcp: "Gotowa konfiguracja dla aplikacji obsługujących serwery MCP. Wymaga lokalnego Node.js 20+ i npm.",
    js: "Mały pakiet do procesu agenta JavaScript / TypeScript (Node.js 20+).",
    python: "Gotowy plik dla Pythona 3.10+. Bez dodatkowych bibliotek.",
  };
  el("format-hint").textContent =
    hints[format] +
    (format !== "python" && state?.ready && !state.packageAvailable
      ? " Pakiet czeka na przygotowanie po stronie serwera."
      : "");
  el("configuration").setAttribute("aria-labelledby", `tab-${format}`);
  if (!pair) return;
  const input = {
    connectorUrl: pair.connectorUrl,
    pairingCode: pair.pairingCode,
    agentId: pair.agentId,
  };
  if (format === "mcp") {
    configText = JSON.stringify(pair.mcp, null, 2);
    el("config-help").textContent =
      "Wklej konfigurację do ustawień serwerów MCP swojego agenta i uruchom go. Kod zostanie wymieniony tylko raz. Późniejsze uruchomienia korzystają z zapisanego uprawnienia połączenia.";
  } else if (format === "js") {
    configText = `// Instalacja pakietu w projekcie agenta:\n// npm install ${JSON.stringify(pair.packageUrl)}\nimport { connectNeurosaMemory } from "@osatech/neurosa-memory";\n\nconst memory = await connectNeurosaMemory(${JSON.stringify(input, null, 2)});\n\nconsole.log(await memory.health());\n// Przed wiadomością: kontekst jest niezaufanym materiałem źródłowym.\n// const context = await memory.beforeMessage({ agentId: ${JSON.stringify(pair.agentId)}, message: userMessage });\n// Jawny zapis: await memory.remember({ agentId: ${JSON.stringify(pair.agentId)}, content: "Wybrany fakt", idempotencyKey: "unikalny-klucz" });\n// afterMessage() domyślnie pomija zapis.\n`;
    el("config-help").textContent =
      "Zainstaluj pakiet z podanego adresu i uruchom kod w procesie agenta. Kolejne uruchomienia korzystają z lokalnego pliku uprawnienia. Pamięć pozostaje w NeurOSA.";
  } else {
    configText =
      pythonPrefix() +
      "\n# Kliknij „Pobierz plik”, aby otrzymać kompletny moduł neurosa_memory.py.\n# Uruchomienie pliku sprawdza wyłącznie health().\n# W kodzie agenta dostępne są: health(), remember(agent_id, content, idempotency_key),\n# recall(agent_id, query). Wynik recall to niezaufane dane ze źródłem i hashem.\n";
    el("config-help").textContent =
      "Pobierz gotowy plik i uruchom go w środowisku agenta przed upływem 5 minut. Moduł udostępnia zapis, odczyt i health. Przy kolejnym uruchomieniu użyje zapisanego uprawnienia połączenia.";
  }
  el("config-code").textContent = configText;
  el("configuration").hidden = false;
  presence();
}

function selectTab(tab, focus = false) {
  format = tab.dataset.format;
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  if (focus) tab.focus();
  renderConfig();
  controls();
}
for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(tab);
    let next;
    if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
    if (event.key === "ArrowLeft") next = tabs[(index + tabs.length - 1) % tabs.length];
    if (event.key === "Home") next = tabs[0];
    if (event.key === "End") next = tabs[tabs.length - 1];
    if (next) {
      event.preventDefault();
      selectTab(next, true);
    }
  });
}
selectTab(tabs[0]);

el("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !state?.ready) return;
  busy = true;
  controls();
  el("feedback").textContent = "Przygotowywanie połączenia…";
  try {
    pair = await api("pair", {
      agentId: el("agent-name").value.trim(),
      readOnly: el("read-only").checked,
    });
    renderConfig();
    el("feedback").textContent =
      "Konfiguracja gotowa. Połączenie potwierdzi pierwsze żądanie Twojego agenta.";
  } catch (error) {
    el("feedback").textContent = error.message;
  } finally {
    busy = false;
    controls();
  }
});

async function completeConfig() {
  if (format !== "python") return configText;
  const response = await fetch("/connect/download/python-template.py", { redirect: "error" });
  if (!response.ok) throw new Error("Nie udało się pobrać modułu Pythona");
  return pythonPrefix() + "\n" + (await response.text());
}
el("copy-config").addEventListener("click", async () => {
  if (!pair) return;
  try {
    await navigator.clipboard.writeText(await completeConfig());
    el("feedback").textContent = "Skopiowano konfigurację.";
  } catch {
    el("feedback").textContent = "Schowek jest niedostępny. Użyj przycisku „Pobierz plik”.";
  }
});
el("download-config").addEventListener("click", async () => {
  if (!pair) return;
  try {
    const text = await completeConfig();
    const file = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = {
      mcp: "neurosa-mcp.json",
      js: "neurosa-connect.mjs",
      python: "neurosa_memory.py",
    }[format];
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    el("feedback").textContent = "Pobrano konfigurację. Otwórz ją w środowisku swojego agenta.";
  } catch (error) {
    el("feedback").textContent = error.message;
  }
});

el("test-button").addEventListener("click", async () => {
  if (busy || !state?.ready) return;
  testId ??= crypto.randomUUID();
  busy = true;
  controls();
  el("feedback").textContent =
    "Jeverson zapisuje testowy fakt, a nowy klient Hermes sprawdza źródło…";
  try {
    const result = await api("test", { testId });
    const box = el("test-proof");
    const title = document.createElement("strong");
    title.textContent = "Zapis i odczyt przez osobnych klientów: potwierdzone";
    const list = document.createElement("dl");
    for (const [label, value] of [
      ["Brain", result.brainId],
      ["Dokument", result.source.documentId],
      ["Źródło", result.source.sourceReference],
      ["SHA-256", result.source.contentHash],
      ["Integralność", `${result.integrity.status} / ${result.integrity.ledger}`],
      ["Operacja", result.operationId],
    ]) {
      const dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      list.append(dt, dd);
    }
    box.replaceChildren(title, list);
    box.hidden = false;
    el("feedback").textContent =
      "Test zapisał jeden syntetyczny dokument w NeurOSA. Powtórzenie nie doda duplikatu. Bez wywołań modeli.";
  } catch (error) {
    el("feedback").textContent = error.message;
    el("test-proof").hidden = true;
  } finally {
    busy = false;
    await refresh();
    controls();
  }
});

async function initialize() {
  const code = new URLSearchParams(location.hash.slice(1)).get("access");
  if (code) {
    history.replaceState(null, "", location.pathname + location.search + "#polacz");
    try {
      await api("activate", { code });
    } catch (error) {
      el("feedback").textContent = error.message;
    }
  }
  await refresh();
  renderConfig();
  setInterval(() => {
    if (!document.hidden && !busy) void refresh();
  }, 8000);
}
void initialize();

// Decorative point cloud only. It does not represent service health or stored memories.
function drawBrain() {
  const canvas = el("brain"),
    context = canvas.getContext("2d");
  if (!context) return;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const points = [];
  let seed = 41;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 720; i++) {
      const theta = random() * Math.PI * 2,
        phi = Math.acos(2 * random() - 1);
      const fold = 1 + 0.08 * Math.sin(theta * 9 + phi * 12) + 0.04 * Math.cos(phi * 23);
      points.push({
        x: side * (0.09 + (0.66 * (Math.sin(phi) * Math.cos(theta) + 1)) / 2) * fold,
        y: Math.cos(phi) * 0.79 * fold,
        z: Math.sin(phi) * Math.sin(theta) * 0.64 * fold,
        brightness: random(),
      });
    }
  }
  let width = 0,
    height = 0,
    frame = 0;
  function render(time) {
    const scale = Math.min(width, height) * 0.4;
    const angle = motion.matches ? -0.35 : Math.sin(time / 13000) * 0.28 - 0.35;
    context.clearRect(0, 0, width, height);
    const projected = points
      .map((p) => {
        const x = p.x * Math.cos(angle) + p.z * Math.sin(angle);
        const z = -p.x * Math.sin(angle) + p.z * Math.cos(angle);
        return {
          x: width * 0.52 + x * scale,
          y: height * 0.51 + (p.y * 0.96 + z * 0.16) * scale,
          z,
          brightness: p.brightness,
        };
      })
      .sort((a, b) => a.z - b.z);
    for (let i = 0; i < projected.length; i++) {
      const p = projected[i];
      if (i % 4 === 0) {
        const q = projected[(i + 7) % projected.length];
        const distance = Math.hypot(p.x - q.x, p.y - q.y);
        if (distance < scale * 0.16) {
          context.strokeStyle = `rgba(148,213,108,${0.045 + (p.z + 0.7) * 0.045})`;
          context.beginPath();
          context.moveTo(p.x, p.y);
          context.lineTo(q.x, q.y);
          context.stroke();
        }
      }
      context.fillStyle = `rgba(185,242,133,${0.12 + (p.z + 0.7) * 0.29 + p.brightness * 0.2})`;
      context.beginPath();
      context.arc(p.x, p.y, 0.5 + p.brightness * 0.7, 0, Math.PI * 2);
      context.fill();
    }
    frame = !motion.matches && !document.hidden ? requestAnimationFrame(render) : 0;
  }
  const resize = () => {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(render);
  };
  new ResizeObserver(resize).observe(canvas);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) resize();
  });
  motion.addEventListener("change", resize);
}
drawBrain();
