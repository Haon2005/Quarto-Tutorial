// qpyodide-document-status.js – Status-Anzeige des Dokuments
//
// Baut die "Pyodide lädt …"-Statuszeile in den Titelblock ein und stellt
// globale Helfer bereit, mit denen andere Module (Engine-Init, Zell-Klassen,
// Feedback) den Status und die Buttons aktualisieren.
//
// Das Einstellungs-Panel für das KI-Feedback lebt NICHT hier, sondern im
// eigenen Modul qpyodide-feedback.js – es hängt sich an den hier erzeugten
// Anker `#qpyodide-status-message-area`.

// Declare startup message element globally
globalThis.qpyodideStartupMessage = document.createElement("p");

// input()-Verfügbarkeit als globaler Zustand (Single Source of Truth für die
// Run-Knopf-Sperre in qpyodide-cell-classes.js). input() braucht Cross-Origin-
// Isolation; das ändert sich innerhalb eines Seitenaufrufs nicht (nur ein Reload
// kann es aktivieren). Zustände: "ok" | "check" (noch nicht geprüft) |
// "needs-reload" (Auto-Reload übersprungen, User muss selbst neu laden) |
// "unavailable" (geprüft, nicht möglich). Dafür gibt es keine sichtbare UI
// mehr – der Check-Reload unten läuft automatisch und unbemerkt im
// Hintergrund; nur falls input() wirklich nicht verfügbar ist, zeigt die
// betroffene Zelle selbst einen stillen Hinweis (siehe updateInputGate() in
// qpyodide-cell-classes.js).
function qpyodideSetInputState(kind) {
  globalThis.qpyodideInputState = kind;
  window.dispatchEvent(new CustomEvent("qpyodide-input-state", { detail: kind }));
}
globalThis.qpyodideInputAvailable = () => globalThis.qpyodideInputState === "ok";
qpyodideSetInputState(globalThis.crossOriginIsolated ? "ok" : "check");

// Merkt sich, ob der User die Seite schon bedient hat (Tastatur/Maus/Touch).
// Verhindert, dass der automatische Check-Reload mitten in einer Eingabe
// passiert und dabei schon getippten Code verwirft.
let qpyodideUserInteracted = false;
["keydown", "pointerdown", "input"].forEach((evt) =>
  window.addEventListener(evt, () => { qpyodideUserInteracted = true; },
    { capture: true, passive: true }));

// Automatischer Check-Reload: sobald coi-serviceworker.js den Service
// Worker registriert hat (Event "coi-sw-ready"), einmal automatisch neu
// laden, damit input() (SharedArrayBuffer) verfügbar wird – außer der User
// tippt in diesem Moment schon irgendwo, dann für diese Sitzung überspringen
// (kein Verlust von ungespeichertem Code). Läuft unabhängig vom
// Startup-Message-Panel, damit es auch bei `show-startup-message: false`
// funktioniert – deshalb hier auf Modul-Ebene und nicht in
// qpyodideDisplayStartupMessage().
console.log("[qpyodide-coi] initialer Zustand: " + globalThis.qpyodideInputState +
  " (crossOriginIsolated=" + globalThis.crossOriginIsolated + ")");

if (!globalThis.crossOriginIsolated) {
  function qpyodideHandleCoiReady() {
    if (qpyodideUserInteracted) {
      console.log("[qpyodide-coi] ready, aber User hat schon interagiert – Reload übersprungen.");
      qpyodideSetInputState("needs-reload");
      return;
    }
    console.log("[qpyodide-coi] ready – löse Reload aus.");
    try { sessionStorage.setItem("qpyodide-coi-reload-pending", "1"); } catch (ex) { /* blockiert */ }
    location.reload();
  }
  function qpyodideHandleCoiUnavailable() {
    console.log("[qpyodide-coi] unavailable.");
    qpyodideSetInputState("unavailable");
  }

  // coi-serviceworker.js legt sein Ergebnis zusätzlich zum Event synchron in
  // globalThis.qpyodideCoiOutcome ab (siehe dort). Grund: Ist der SW schon
  // aus einem früheren Reload aktiv, kann dieses Skript hier schneller
  // fertig sein, als coi-serviceworker.js sein Event feuert – ein reiner
  // Event-Listener würde das dann verpassen. Erst synchron den bereits
  // vorliegenden Zustand prüfen, nur falls der noch fehlt auf das Event warten.
  if (globalThis.qpyodideCoiOutcome === "ready") {
    qpyodideHandleCoiReady();
  } else if (globalThis.qpyodideCoiOutcome === "unavailable") {
    qpyodideHandleCoiUnavailable();
  } else {
    window.addEventListener("coi-sw-ready", qpyodideHandleCoiReady, { once: true });
    window.addEventListener("coi-unavailable", qpyodideHandleCoiUnavailable, { once: true });

    // Fallback: Falls coi-serviceworker.js gar nicht lädt (z. B. Seite direkt
    // als Datei geöffnet statt über einen Webserver – dann zeigt der absolute
    // Script-Pfad "/coi-serviceworker.js" unter file:// ins Leere), feuert
    // weder "coi-sw-ready" noch "coi-unavailable". Ohne diesen Fallback würden
    // Zellen mit input() dauerhaft im "wird aktiviert"-Zwischenzustand hängen.
    const qpyodideCoiFallback = setTimeout(() => {
      console.log("[qpyodide-coi] 5s-Fallback ausgelöst (weder coi-sw-ready noch coi-unavailable kam an).");
      qpyodideSetInputState("unavailable");
    }, 5000);
    window.addEventListener("coi-sw-ready",    () => clearTimeout(qpyodideCoiFallback), { once: true });
    window.addEventListener("coi-unavailable", () => clearTimeout(qpyodideCoiFallback), { once: true });
  }
}

// Set the text/state of every Run- and Feedback-button on the page
globalThis.qpyodideSetInteractiveButtonState = function(buttonText, enableCodeButton = true) {
  document.querySelectorAll(".qpyodide-button-run").forEach((btn) => {
    btn.innerHTML = buttonText;
    // input()-Zellen bleiben gesperrt, solange input() nicht verfügbar ist
    btn.disabled = !enableCodeButton ||
      (btn.dataset.needsInput === "1" && !globalThis.qpyodideInputAvailable());
  });
  document.querySelectorAll(".qpyodide-button-feedback").forEach((btn) => {
    btn.disabled = !enableCodeButton;
  });
}

// Update the status message in non-interactive (output/setup) cells
globalThis.qpyodideUpdateStatusMessage = function(message) {
  document.querySelectorAll(".qpyodide-status-text.qpyodide-cell-needs-evaluation").forEach((elem) => {
    elem.innerText = message;
  });
}

// Update the document status header with a spinner (loading phases)
globalThis.qpyodideUpdateStatusHeaderSpinner = function(message) {
  qpyodideStartupMessage.innerHTML = `
    <i class="fa-solid fa-spinner fa-spin qpyodide-icon-status-spinner"></i>
    <span>${message}</span>`;
}

// Update the document status header with plain text (final states)
globalThis.qpyodideUpdateStatusHeader = function(message) {
  qpyodideStartupMessage.innerHTML = `<span>${message}</span>`;
}

// Attach the document status message to the title block (or create one)
function qpyodideDisplayStartupMessage(showStartupMessage) {
  if (!showStartupMessage) {
    return;
  }

  // Get references to header elements
  const headerHTML = document.getElementById("title-block-header");
  const headerRevealJS = document.getElementById("title-slide");

  // Create the outermost div element for metadata
  const quartoTitleMeta = document.createElement("div");
  quartoTitleMeta.classList.add("quarto-title-meta");

  // Create the status area; qpyodide-feedback.js appends its settings panel here
  const statusArea = document.createElement("div");
  statusArea.setAttribute("id", "qpyodide-status-message-area");

  // Create the heading div
  const statusTitle = document.createElement("div");
  statusTitle.setAttribute("id", "qpyodide-status-message-title");
  statusTitle.classList.add("quarto-title-meta-heading");
  statusTitle.innerText = "";

  // Create the contents div holding the live status text
  const statusContents = document.createElement("div");
  statusContents.setAttribute("id", "qpyodide-status-message-body");
  statusContents.classList.add("quarto-title-meta-contents");

  // Describe the Pyodide state
  qpyodideStartupMessage.innerText = QP_L.loadingPython;
  qpyodideStartupMessage.setAttribute("id", "qpyodide-status-message-text");
  // Add `aria-live` to auto-announce the startup status to screen readers
  qpyodideStartupMessage.setAttribute("aria-live", "assertive");

  // Status-Zeile: Ladetext links, Buttons rechts – eine kompakte Zeile
  const statusRow = document.createElement("div");
  statusRow.style.cssText = "display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap";
  qpyodideStartupMessage.style.cssText = "flex:1; margin:0";
  statusRow.appendChild(qpyodideStartupMessage);

  // Rechter Bereich: KI-Feedback-Button
  // qpyodide-feedback.js hängt seinen Toggle-Button hier ein (id: qpyodide-status-right)
  const statusRight = document.createElement("div");
  statusRight.id = "qpyodide-status-right";
  statusRight.style.cssText = "display:flex; align-items:center; gap:0.5rem; flex-shrink:0";
  statusRow.appendChild(statusRight);

  statusContents.appendChild(statusRow);

  // Aufklappbare Panels unterhalb der Status-Zeile
  // qpyodide-feedback.js hängt sein Einstellungs-Panel hier ein (id: qpyodide-status-panels)
  const statusPanels = document.createElement("div");
  statusPanels.id = "qpyodide-status-panels";
  statusContents.appendChild(statusPanels);

  // Combine the inner divs and contents
  statusArea.appendChild(statusTitle);
  statusArea.appendChild(statusContents);
  quartoTitleMeta.appendChild(statusArea);

  // Determine where to insert the quartoTitleMeta element
  if (headerHTML || headerRevealJS) {
    // Append to the existing "title-block-header" element or "title-slide" div
    (headerHTML || headerRevealJS).appendChild(quartoTitleMeta);
  } else {
    // If neither headerHTML nor headerRevealJS is found, insert after the
    // "qpyodide-monaco-editor-init" script
    const monacoScript = document.getElementById("qpyodide-monaco-editor-init");
    const header = document.createElement("header");
    header.setAttribute("id", "title-block-header");
    header.appendChild(quartoTitleMeta);
    monacoScript.after(header);
  }
}

qpyodideDisplayStartupMessage(qpyodideShowStartupMessage);
