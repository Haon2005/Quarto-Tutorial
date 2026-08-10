// qpyodide-feedback.js – KI-Feedback-Modul (EINE Implementierung für alle Zellen)
//
// Stellt `globalThis.qpyodideFeedback` bereit:
//   attach(unit)     – verdrahtet den Feedback-Button einer Editor-Einheit;
//                      `unit` liefert { uid, feedbackButton, feedbackDiv,
//                      getCode(), runForOutput() }
//   buildSettingsUI()– baut das (einklappbare) Einstellungs-Panel auf
//
// Anbieter-neutral: jeder OpenAI-kompatible Endpunkt funktioniert über
// POST {baseUrl}/chat/completions mit Bearer-Key und frei wählbarem Modell
// (OpenRouter, Cerebras, Groq, OpenAI, Ollama, …). Es wird NICHTS geraten –
// insbesondere kein Modell-Lookup über GET /models.
//
// Zwei Modi:
//   "api"  – Direktaufruf der API (Standard)
//   "copy" – erzeugt einen kopierbaren Prompt inkl. System-Prompt für
//            ChatGPT/Claude & Co. (kein API-Key nötig)
//
// Konfiguration wird je nach Wahl in localStorage (dauerhaft) oder
// sessionStorage (pro Tab) abgelegt – ausschließlich im Browser des Nutzers.

const qfOptions = globalThis.qpyodideFeedbackOptions ?? { enabled: false, storage: "local", hints: true };

const QF_STORAGE_KEY = "qpyodide-feedback-config";

// ---------------------------------------------------------------------------
// Konfiguration laden/speichern
// ---------------------------------------------------------------------------

function qfLoadConfig() {
  for (const store of [localStorage, sessionStorage]) {
    try {
      const raw = store.getItem(QF_STORAGE_KEY);
      if (raw) {
        const cfg = JSON.parse(raw);
        cfg.storage = (store === localStorage) ? "local" : "session";
        return cfg;
      }
    } catch (e) { /* defektes JSON oder blockierter Storage -> ignorieren */ }
  }
  return { baseUrl: "", apiKey: "", model: "", mode: "api", storage: qfOptions.storage || "local" };
}

function qfSaveConfig(cfg) {
  const target = (cfg.storage === "session") ? sessionStorage : localStorage;
  const other  = (cfg.storage === "session") ? localStorage : sessionStorage;
  try {
    target.setItem(QF_STORAGE_KEY, JSON.stringify(cfg));
    other.removeItem(QF_STORAGE_KEY);
  } catch (e) {
    console.warn("qpyodide-feedback: Speichern der Konfiguration fehlgeschlagen", e);
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

// Prompts kommen aus der Locale-Tabelle (qpyodide-locales.js), damit der Tutor
// in der Sprache der Seite antwortet.
const QF_SYSTEM_PROMPT = QP_L.systemPrompt;

// Zusatz-Instruktion je Hinweis-Stufe (steigt mit der Klick-Anzahl pro Zelle)
const QF_HINT_INSTRUCTIONS = QP_L.hintInstructions;

function qfBuildUserPrompt(code, output, hintLevel) {
  let prompt =
    QP_L.promptCodeIntro + "\n```python\n" + code + "\n```\n\n" +
    QP_L.promptOutputIntro + "\n```\n" +
    (output && output.trim() ? output : QP_L.promptNoOutput) + "\n```";
  if (hintLevel > 0) {
    prompt += "\n\n" + (QF_HINT_INSTRUCTIONS[Math.min(hintLevel, 3)]);
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// API-Aufruf (OpenAI-kompatibel)
// ---------------------------------------------------------------------------

async function qfRequestFeedback(cfg, messages) {
  const endpoint = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";

  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) {
    headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  }

  // Token-Limit nur als großzügiges Sicherheitsnetz gegen Endlos-Ausgaben –
  // die eigentliche Längenbegrenzung steht im System-Prompt (~250 Wörter).
  // So wird das Feedback nicht mehr mitten im Satz abgeschnitten.
  // Modern: beide Token-Felder setzen; manche Anbieter lehnen eines ab – in
  // dem Fall einmal ohne das beanstandete Feld erneut versuchen.
  let body = {
    model: cfg.model,
    messages: messages,
    max_tokens: 2000,
    max_completion_tokens: 2000
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      // Beanstandetes Token-Feld entfernen und erneut versuchen
      if (response.status === 400 && "max_completion_tokens" in body && /max_completion_tokens/.test(errorText)) {
        delete body.max_completion_tokens;
        continue;
      }
      if (response.status === 400 && "max_tokens" in body && /max_tokens/.test(errorText)) {
        delete body.max_tokens;
        continue;
      }
      throw new Error(`HTTP ${response.status} ${response.statusText}\n${errorText.slice(0, 600)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(QP_L.errNoContent);
    }
    return content;
  }
  throw new Error(QP_L.errTokenRejected);
}

// ---------------------------------------------------------------------------
// Modell-Liste abrufen (expliziter Klick im Panel – kein stilles Raten)
// ---------------------------------------------------------------------------

// Ist ein Modell kostenlos? true/false, oder null wenn der Anbieter keine
// Preisinfo liefert (z. B. Groq, Cerebras, Ollama).
function qfIsFreeModel(model) {
  if (typeof model.id === "string" && model.id.endsWith(":free")) return true;
  const pricing = model.pricing;
  if (pricing && ("prompt" in pricing || "completion" in pricing)) {
    return Number(pricing.prompt ?? 0) === 0 && Number(pricing.completion ?? 0) === 0;
  }
  return null;
}

async function qfFetchModels(baseUrl, apiKey) {
  const endpoint = baseUrl.replace(/\/+$/, "") + "/models";
  const headers = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}\n${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  const list = Array.isArray(data.data) ? data.data
             : Array.isArray(data.models) ? data.models
             : [];
  return list
    .map((model) => ({ id: model.id || model.name, free: qfIsFreeModel(model) }))
    .filter((model) => typeof model.id === "string" && model.id);
}

// ---------------------------------------------------------------------------
// Rendering (sicher: Modell-Ausgabe wird escaped, dann Mini-Markdown)
// ---------------------------------------------------------------------------

function qfEscapeHtml(text) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Sehr kleine Markdown-Teilmenge: ```Codeblöcke```, `inline code`, **fett**
function qfRenderMarkdownLite(text) {
  const parts = text.split(/```(?:[a-zA-Z0-9_-]*\n)?/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // Inhalt zwischen ```-Zäunen
      html += "<pre class='qpyodide-feedback-code'><code>" + qfEscapeHtml(parts[i]) + "</code></pre>";
    } else {
      let chunk = qfEscapeHtml(parts[i]);
      chunk = chunk.replace(/`([^`\n]+)`/g, "<code>$1</code>");
      chunk = chunk.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      chunk = chunk.replace(/\n/g, "<br>");
      html += chunk;
    }
  }
  return html;
}

function qfRenderFeedback(targetDiv, feedbackText, hintLevel) {
  targetDiv.innerHTML = "";

  const header = document.createElement("div");
  header.className = "qpyodide-feedback-header";
  header.textContent = QP_L.feedbackHeader +
    (hintLevel > 0 ? QP_L.feedbackHintLevel(Math.min(hintLevel, 3)) : "") + ":";
  targetDiv.appendChild(header);

  const bodyDiv = document.createElement("div");
  bodyDiv.className = "qpyodide-feedback-body";
  bodyDiv.innerHTML = qfRenderMarkdownLite(feedbackText);
  targetDiv.appendChild(bodyDiv);

  targetDiv.classList.add("has-content");
}

function qfRenderError(targetDiv, message) {
  targetDiv.innerHTML = "";

  const box = document.createElement("div");
  box.className = "qpyodide-feedback-error";
  const header = document.createElement("strong");
  header.textContent = QP_L.feedbackErrorHeader;
  const text = document.createElement("span");
  text.textContent = message;
  box.appendChild(header);
  box.appendChild(text);
  targetDiv.appendChild(box);

  targetDiv.classList.add("has-content");
}

// Box mit kopierbarem Prompt (Modus "Prompt kopieren", inkl. System-Prompt)
function qfRenderCopyPrompt(targetDiv, promptText) {
  targetDiv.innerHTML = "";

  const header = document.createElement("div");
  header.className = "qpyodide-feedback-header";
  header.textContent = QP_L.copyPromptHeader;
  targetDiv.appendChild(header);

  const pre = document.createElement("pre");
  pre.className = "qpyodide-feedback-code qpyodide-feedback-copyprompt";
  pre.textContent = promptText;
  targetDiv.appendChild(pre);

  const copyBtn = document.createElement("button");
  copyBtn.className = "btn btn-default qpyodide-button";
  copyBtn.type = "button";
  copyBtn.textContent = QP_L.copyPromptBtn;
  copyBtn.onclick = function() {
    navigator.clipboard.writeText(promptText).then(function() {
      copyBtn.textContent = QP_L.copyPromptDone;
      setTimeout(function() { copyBtn.textContent = QP_L.copyPromptBtn; }, 2000);
    });
  };
  targetDiv.appendChild(copyBtn);

  targetDiv.classList.add("has-content");
}

// ---------------------------------------------------------------------------
// Einstellungs-Panel
// ---------------------------------------------------------------------------

const qfUi = {};   // Referenzen auf die UI-Elemente des Panels

function qfMakeField(labelText, input) {
  // <div> instead of <label> avoids the double-click issue on <select> wrappers
  const wrapper = document.createElement("div");
  wrapper.className = "qpyodide-feedback-field";
  const span = document.createElement("span");
  span.textContent = labelText;
  wrapper.appendChild(span);
  wrapper.appendChild(input);
  return wrapper;
}

function qfBuildHelpBox() {
  const helpDiv = document.createElement("div");
  helpDiv.className = "qpyodide-feedback-help";
  helpDiv.style.display = "none";
  helpDiv.innerHTML = QP_L.helpBox;
  return helpDiv;
}

// Anbieter-Vorlagen: füllen Base URL + Beispiel-Modell per Klick aus,
// damit Anfänger nichts abtippen müssen. Der Key kommt vom Nutzer.
const QF_PROVIDER_PRESETS = {
  cerebras:   { label: QP_L.presetCerebras,   baseUrl: "https://api.cerebras.ai/v1",  model: "gpt-oss-120b",                          modelsUrl: "https://inference-docs.cerebras.ai/models/overview" },
  openrouter: { label: QP_L.presetOpenrouter, baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", modelsUrl: "https://openrouter.ai/models?max_price=0" },
  openai:     { label: QP_L.presetOpenai,     baseUrl: "https://api.openai.com/v1",    model: "gpt-4o-mini",                           modelsUrl: "https://platform.openai.com/docs/models" },
  ollama:     { label: QP_L.presetOllama,     baseUrl: "http://localhost:11434/v1",    model: "" }
};

function qfBuildSettingsUI() {
  const cfg = qfLoadConfig();

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "btn btn-light btn-sm qpyodide-button qpyodide-feedback-toggle";
  toggleBtn.innerHTML = '<i class="fa-solid fa-gear"></i>';
  toggleBtn.title = QP_L.gearTitle;

  const statusSpan = document.createElement("span");
  statusSpan.className = "qpyodide-feedback-settings-status";

  const panel = document.createElement("div");
  panel.className = "qpyodide-feedback-panel";

  // Anbieter-Vorlage (füllt Base URL + Beispiel-Modell aus)
  const presetSelect = document.createElement("select");
  presetSelect.add(new Option(QP_L.presetPlaceholder, ""));
  for (const [key, preset] of Object.entries(QF_PROVIDER_PRESETS)) {
    presetSelect.add(new Option(preset.label, key));
  }

  // Eingabefelder
  const baseUrlInput = document.createElement("input");
  baseUrlInput.type = "text";
  baseUrlInput.placeholder = QP_L.phBaseUrl;
  baseUrlInput.value = cfg.baseUrl || "";
  baseUrlInput.autocomplete = "off";

  const apiKeyInput = document.createElement("input");
  apiKeyInput.type = "password";
  apiKeyInput.placeholder = QP_L.phApiKey;
  apiKeyInput.value = cfg.apiKey || "";
  apiKeyInput.autocomplete = "off";

  const modelInput = document.createElement("input");
  modelInput.type = "text";
  modelInput.placeholder = QP_L.phModel;
  modelInput.value = cfg.model || "";
  modelInput.autocomplete = "off";

  const modeSelect = document.createElement("select");
  const optApi = new Option(QP_L.modeApi, "api");
  const optCopy = new Option(QP_L.modeCopy, "copy");
  modeSelect.add(optApi);
  modeSelect.add(optCopy);
  modeSelect.value = cfg.mode || "api";


  presetSelect.onchange = () => {
    const preset = QF_PROVIDER_PRESETS[presetSelect.value];
    if (preset) {
      baseUrlInput.value = preset.baseUrl;
      modelInput.value = "";
      modelHintEl.style.display = "none";
      modelHintEl.innerHTML = "";
      doFetchModels(true);
    }
  };

  // „Modelle abrufen": fragt {baseUrl}/models ab und zeigt eine Auswahlliste,
  // standardmäßig gefiltert auf kostenlose Modelle (damit niemand aus
  // Versehen Geld ausgibt).
  const fetchModelsBtn = document.createElement("button");
  fetchModelsBtn.type = "button";
  fetchModelsBtn.className = "btn btn-light btn-sm qpyodide-button";
  fetchModelsBtn.innerHTML = QP_L.fetchModelsBtn;

  const modelRow = document.createElement("div");
  modelRow.className = "qpyodide-feedback-inputrow";
  modelRow.appendChild(modelInput);
  modelRow.appendChild(fetchModelsBtn);

  const modelHintEl = document.createElement("div");
  modelHintEl.style.cssText = "font-size:0.85em;color:#888;margin-top:3px;display:none";

  const modelListDiv = document.createElement("div");
  modelListDiv.className = "qpyodide-feedback-modellist";
  modelListDiv.style.display = "none";

  const modelListInfo = document.createElement("div");
  modelListInfo.className = "qpyodide-feedback-modellist-info";

  const freeOnlyLabel = document.createElement("label");
  const freeOnlyCheckbox = document.createElement("input");
  freeOnlyCheckbox.type = "checkbox";
  freeOnlyCheckbox.checked = true;
  freeOnlyLabel.appendChild(freeOnlyCheckbox);
  freeOnlyLabel.appendChild(document.createTextNode(QP_L.freeOnlyLabel));

  const modelPicker = document.createElement("select");

  modelListDiv.appendChild(modelListInfo);
  modelListDiv.appendChild(freeOnlyLabel);
  modelListDiv.appendChild(modelPicker);

  let fetchedModels = [];

  function renderModelList() {
    const hasPricingInfo = fetchedModels.some((model) => model.free !== null);
    freeOnlyLabel.style.display = hasPricingInfo ? "block" : "none";

    let models = fetchedModels;
    if (hasPricingInfo && freeOnlyCheckbox.checked) {
      models = models.filter((model) => model.free === true);
    }
    // Kostenlose zuerst, dann alphabetisch
    models = models.slice().sort((a, b) =>
      (b.free === true) - (a.free === true) || a.id.localeCompare(b.id)
    );

    modelPicker.innerHTML = "";
    modelPicker.style.display = "";
    modelPicker.add(new Option(QP_L.modelChoose(models.length), ""));
    models.forEach((model) => {
      const suffix = model.free === true ? QP_L.modelSuffixFree
                   : model.free === false ? QP_L.modelSuffixPaid
                   : "";
      modelPicker.add(new Option(model.id + suffix, model.id));
    });

    modelListInfo.textContent = hasPricingInfo
      ? QP_L.modelListInfoPricing
      : QP_L.modelListInfoNoPricing;
    modelListDiv.style.display = "block";
  }

  freeOnlyCheckbox.onchange = renderModelList;

  modelPicker.onchange = () => {
    if (modelPicker.value) {
      modelInput.value = modelPicker.value;
    }
  };

  // Modelle abrufen – per Button (isAuto=false) oder automatisch nach
  // Vorlagenwahl (isAuto=true). Beim Auto-Abruf scheitert es ohne Key/CORS oft;
  // dann bleibt das eingetragene Beispielmodell als Fallback stehen und die
  // Meldung bleibt sanft statt als roter Fehler.
  async function doFetchModels(isAuto) {
    const baseUrl = baseUrlInput.value.trim();
    if (!baseUrl) {
      if (isAuto) return;
      modelListInfo.textContent = QP_L.errNeedBaseUrl;
      freeOnlyLabel.style.display = "none";
      modelPicker.innerHTML = "";
      modelPicker.style.display = "none";
      modelListDiv.style.display = "block";
      return;
    }

    const originalLabel = fetchModelsBtn.innerHTML;
    fetchModelsBtn.disabled = true;
    fetchModelsBtn.innerHTML = QP_L.fetchModelsBusy;
    try {
      fetchedModels = await qfFetchModels(baseUrl, apiKeyInput.value.trim());
      if (fetchedModels.length === 0) {
        throw new Error(QP_L.errNoModels);
      }
      const freeOnes = fetchedModels.filter((m) => m.free === true);
      const pool = freeOnes.length > 0 ? freeOnes : fetchedModels;
      modelInput.value = pool[Math.floor(Math.random() * pool.length)].id;
      modelHintEl.style.display = "none";
      modelHintEl.innerHTML = "";
      renderModelList();
    } catch (error) {
      if (isAuto) {
        const preset = QF_PROVIDER_PRESETS[presetSelect.value];
        if (preset?.modelsUrl) {
          modelHintEl.innerHTML = QP_L.modelHintKeyNeeded(preset.modelsUrl);
          modelHintEl.style.display = "";
        }
        return;
      }
      modelListInfo.textContent = QP_L.errModelListFailed(error.message || error);
      freeOnlyLabel.style.display = "none";
      modelPicker.innerHTML = "";
      modelPicker.style.display = "none";
      modelListDiv.style.display = "block";
    } finally {
      fetchModelsBtn.disabled = false;
      fetchModelsBtn.innerHTML = originalLabel;
    }
  }

  fetchModelsBtn.onclick = () => doFetchModels(false);

  panel.appendChild(qfMakeField(QP_L.fieldPreset, presetSelect));
  panel.appendChild(qfMakeField(QP_L.fieldBaseUrl, baseUrlInput));
  panel.appendChild(qfMakeField(QP_L.fieldApiKey, apiKeyInput));
  panel.appendChild(qfMakeField(QP_L.fieldModel, modelRow));
  panel.appendChild(modelHintEl);
  panel.appendChild(modelListDiv);
  panel.appendChild(qfMakeField(QP_L.fieldMode, modeSelect));

  // Aktionszeile: Speichern + Hilfe
  const actionRow = document.createElement("div");
  actionRow.className = "qpyodide-feedback-actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn-default qpyodide-button";
  saveBtn.textContent = QP_L.saveBtn;

  const infoBtn = document.createElement("button");
  infoBtn.type = "button";
  infoBtn.className = "btn btn-light btn-sm qpyodide-button";
  infoBtn.textContent = QP_L.infoBtn;

  actionRow.appendChild(saveBtn);
  actionRow.appendChild(infoBtn);
  panel.appendChild(actionRow);

  const helpDiv = qfBuildHelpBox();
  panel.appendChild(helpDiv);

  // Verhalten
  function setCollapsed(collapsed) {
    panel.style.display = collapsed ? "none" : "block";
  }

  toggleBtn.onclick = () => setCollapsed(panel.style.display !== "none");
  infoBtn.onclick = () => {
    helpDiv.style.display = (helpDiv.style.display === "none") ? "block" : "none";
  };

  saveBtn.onclick = () => {
    const newCfg = {
      baseUrl: baseUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim(),
      mode: modeSelect.value,
      storage: "local"
    };
    qfSaveConfig(newCfg);
    statusSpan.textContent = QP_L.saveDone;
    setTimeout(() => { statusSpan.textContent = ""; }, 3000);
    // Auto-Einklappen nach dem Speichern
    setCollapsed(true);
  };

  // Immer eingeklappt starten – das Panel wird erst per Zahnrad geöffnet.
  setCollapsed(true);

  qfUi.panel = panel;
  qfUi.setCollapsed = setCollapsed;

  // Toggle-Button und Status-Span rechts neben die Status-Zeile einreihen
  const rightArea = document.getElementById("qpyodide-status-right");
  if (rightArea) {
    rightArea.appendChild(toggleBtn);
    rightArea.appendChild(statusSpan);
  } else {
    // Fallback: vor der ersten Pyodide-Zelle
    const firstCell = document.querySelector('[id^="qpyodide-insertion-location-"]');
    const wrap = document.createElement("div");
    wrap.appendChild(toggleBtn);
    wrap.appendChild(statusSpan);
    firstCell
      ? firstCell.parentNode.insertBefore(wrap, firstCell)
      : document.body.prepend(wrap);
  }

  // Einstellungs-Panel unterhalb der Status-Zeile anhängen
  const panelsArea = document.getElementById("qpyodide-status-panels");
  if (panelsArea) {
    panelsArea.appendChild(panel);
  } else {
    const statusArea = document.getElementById("qpyodide-status-message-area");
    (statusArea ?? document.body).appendChild(panel);
  }
}

// ---------------------------------------------------------------------------
// Klick-Handler (von den Zell-Klassen über attach() verdrahtet)
// ---------------------------------------------------------------------------

// Klick-Zähler pro Editor-Einheit für progressive Hinweise
const qfClickCounts = new Map();

async function qfGiveFeedback(unit) {
  const button = unit.feedbackButton;
  const targetDiv = unit.feedbackDiv;
  if (!button || !targetDiv || button.dataset.qfBusy === "1") return;

  const cfg = qfLoadConfig();

  // Hinweis-Stufe ermitteln (0 = Feature deaktiviert)
  let hintLevel = 0;
  if (qfOptions.hints) {
    hintLevel = Math.min((qfClickCounts.get(unit.uid) || 0) + 1, 3);
    qfClickCounts.set(unit.uid, hintLevel);
  }

  const originalLabel = button.innerHTML;
  button.dataset.qfBusy = "1";
  button.disabled = true;
  button.innerHTML = QP_L.feedbackBusy;

  try {
    // Code ausführen, um dem Modell die Interpreter-Ausgabe mitzugeben
    const code = unit.getCode();
    const output = await unit.runForOutput();

    if (cfg.mode === "copy") {
      const fullPrompt = QF_SYSTEM_PROMPT + "\n\n" + qfBuildUserPrompt(code, output, hintLevel);
      qfRenderCopyPrompt(targetDiv, fullPrompt);
      return;
    }

    // Direkt-API: Konfiguration prüfen (Key ist optional, z. B. bei Ollama)
    if (!cfg.baseUrl || !cfg.model) {
      qfRenderError(targetDiv, QP_L.errConfigMissing);
      if (qfUi.setCollapsed) qfUi.setCollapsed(false);
      return;
    }

    const messages = [
      { role: "system", content: QF_SYSTEM_PROMPT },
      { role: "user", content: qfBuildUserPrompt(code, output, hintLevel) }
    ];

    const feedback = await qfRequestFeedback(cfg, messages);
    qfRenderFeedback(targetDiv, feedback, hintLevel);

  } catch (error) {
    qfRenderError(targetDiv, error.message || String(error));
  } finally {
    button.dataset.qfBusy = "0";
    button.disabled = false;
    button.innerHTML = originalLabel;
  }
}

// ---------------------------------------------------------------------------
// Öffentliche Schnittstelle
// ---------------------------------------------------------------------------

globalThis.qpyodideFeedback = {
  enabled: !!qfOptions.enabled,

  /** Feedback-Button einer Editor-Einheit verdrahten. */
  attach(unit) {
    if (!this.enabled || !unit.feedbackButton) return;
    unit.feedbackButton.onclick = () => qfGiveFeedback(unit);
  }
};

// Einstellungs-Panel aufbauen (Module sind deferred, das DOM ist also bereit)
if (qfOptions.enabled) {
  qfBuildSettingsUI();
}
