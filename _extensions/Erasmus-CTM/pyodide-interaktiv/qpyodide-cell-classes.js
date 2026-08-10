// qpyodide-cell-classes.js – Zell-Klassen der Extension `pyodide-interaktiv`
//
// Aufbau (klare Trennung, keine Duplikation):
//   qpyodideExecutePython()  – gemeinsame Ausführungs-Schicht (eine Stelle!)
//   EditorUnit               – EIN Monaco-Editor mit Toolbar + Ausgabe-Bereichen;
//                              wird sowohl für die Hauptzelle als auch für per
//                              „+ Codeblock" ergänzte Zusatz-Editoren benutzt
//   InteractiveCell          – <details>-Wrapper um eine (oder mehrere) EditorUnit(s)
//   OutputCell               – führt Code aus und zeigt nur die Ausgabe
//   SetupCell                – führt Code unsichtbar aus (Setup-Kontext)
//   CellContainer            – Sammlung aller Zellen, startet setup/output/autorun
//
// Das KI-Feedback lebt vollständig in qpyodide-feedback.js und wird hier nur
// über qpyodideFeedback.attach(unit) verdrahtet.

// ---------------------------------------------------------------------------
// Theme-Kopplung (Quarto-Dark-Mode <-> Monaco & Bootstrap-Variablen)
// ---------------------------------------------------------------------------

function qpyodideIsDarkMode() {
  const cls = document.body.classList;
  if (cls.contains("quarto-dark")) return true;
  if (cls.contains("quarto-light")) return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function qpyodideMonacoTheme() {
  return qpyodideIsDarkMode() ? "vs-dark" : "vs";
}

function qpyodideSyncMonacoTheme() {
  if (globalThis.monaco) {
    monaco.editor.setTheme(qpyodideMonacoTheme());
  }
}

// Bootstrap setzt seine Dark-Mode-Variablen (--bs-body-bg, --bs-border-color, ...)
// nur unter [data-bs-theme=dark], Quarto togglet aber nur body.quarto-dark/-light.
// Ohne diesen Sync loesen var(--bs-*)-Referenzen im Dark Mode auf generische,
// helle Fallback-Werte auf statt auf die Farben des aktiven Themes (z. B. slate).
// Scope bewusst auf <body> statt <html>, damit nur der Seiteninhalt betroffen
// ist, nicht Quartos eigene Navbar (die ihr data-bs-theme="dark" schon fest hat).
function qpyodideSyncBsTheme() {
  document.body.setAttribute("data-bs-theme", qpyodideIsDarkMode() ? "dark" : "light");
}

function qpyodideSyncTheme() {
  qpyodideSyncMonacoTheme();
  qpyodideSyncBsTheme();
}

// Live auf Theme-Wechsel reagieren (Quarto toggelt Klassen auf <body>)
new MutationObserver(qpyodideSyncTheme)
  .observe(document.body, { attributes: true, attributeFilter: ["class"] });
window.matchMedia?.("(prefers-color-scheme: dark)")
  .addEventListener?.("change", qpyodideSyncTheme);
qpyodideSyncBsTheme();

// ---------------------------------------------------------------------------
// Gemeinsame Ausführungs-Schicht
// ---------------------------------------------------------------------------

// UI-Sperre: pro Klick rechnet eine Zelle; die Seite selbst bleibt frei,
// weil Python im Web Worker läuft.
let qpyodideExecutionBusy = false;

// Erkennt input()-Aufrufe im Code (gleiche Heuristik wie runForOutput()).
function qpyodideCodeHasInput(code) {
  return /\binput\s*\(/.test(code || "");
}

function qpyodideSetRunButtonsEnabled(enabled) {
  document.querySelectorAll(".qpyodide-button-run").forEach((btn) => {
    // input()-Zellen bleiben gesperrt, solange input() nicht verfügbar ist
    btn.disabled = !enabled ||
      (btn.dataset.needsInput === "1" && !globalThis.qpyodideInputAvailable());
  });
}

/**
 * Führt Python-Code im Pyodide-Worker aus.
 * @param {string}  code       auszuführender Python-Code
 * @param {boolean} wantPickle Figuren zusätzlich als pickle liefern
 *                             (nur nötig, wenn auf Canvas umgestellt wird)
 * @returns {Promise<{entries: Array, text: string, html: ?string, images: string[],
 *                    pickles: string[], pickleErrors: string[],
 *                    animations: string[], animationErrors: string[]}>}
 *   entries    – stdout/stderr-Zeilen, text – als Klartext verbunden,
 *   html       – HTML-Rückgabewert der letzten Anweisung (oder null),
 *   animations – automatisch erkannte Animationen als fertiges Player-HTML,
 *   images     – die übrigen matplotlib-Figuren als base64-PNGs,
 *   pickles    – dieselben Figuren als base64-pickle (leer ohne wantPickle)
 */
async function qpyodideExecutePython(code, wantPickle) {
  const pyodide = await qpyodideReady;
  const result = await pyodide.runCell(code, wantPickle);
  result.text = result.entries.map((entry) => entry.message).join("\n");
  return result;
}

/**
 * Text-Ausgabe (stdout/stderr) sicher in einen Container rendern.
 * @returns {boolean} true, wenn sichtbarer Inhalt entstanden ist.
 */
function qpyodideRenderTextOutput(targetDiv, entries) {
  const pre = document.createElement("pre");
  let hasContent = false;

  entries.forEach((entry) => {
    if (!/\S/.test(entry.message)) return;
    const line = document.createElement("code");
    line.className = (entry.type === "stderr")
      ? "qpyodide-output-code-stderr"
      : "qpyodide-output-code-stdout";
    line.textContent = entry.message;
    pre.appendChild(line);
    pre.appendChild(document.createTextNode("\n"));
    hasContent = true;
  });

  if (!hasContent) {
    pre.style.visibility = "hidden";
  }
  targetDiv.appendChild(pre);
  return hasContent;
}

/**
 * matplotlib-Figuren (base64-PNGs aus dem Worker) als <figure> rendern.
 * @returns {boolean} true, wenn eine Figur eingefügt wurde.
 */
function qpyodideRenderImages(targetDiv, images, figCap) {
  if (!images || images.length === 0) return false;
  const figure = document.createElement("figure");
  images.forEach((base64Png) => {
    const img = document.createElement("img");
    img.src = "data:image/png;base64," + base64Png;
    img.alt = figCap || "Plot";
    figure.appendChild(img);
  });
  if (figCap) {
    const figcaption = document.createElement("figcaption");
    figcaption.innerText = figCap;
    figure.appendChild(figcaption);
  }
  targetDiv.appendChild(figure);
  return true;
}

/**
 * Plot-Ausgabe eines Laufs rendern.
 *
 * Zuerst die Animationen: die kommen als fertiges Player-HTML aus dem Worker
 * (matplotlib `to_jshtml`) und stehen dort schon anstelle der Figur, die sonst
 * als eingefrorenes Standbild käme. Danach die PNGs der übrigen Figuren – die
 * sind sofort da. Wenn für die Zelle interaktive Plots gewünscht sind, wird
 * anschließend im Hintergrund auf Canvas umgestellt (zweite Pyodide-Instanz,
 * siehe qpyodide-canvas-plots.js). Nicht umgestellt wird bei einer
 * HTML-Rückgabe (Plotly, zeige_svg) und wenn nicht jede Figur ein brauchbares
 * pickle hat.
 */
function qpyodideRenderPlots(targetDiv, result, options) {
  const animations = result.animations || [];
  animations.forEach((animHtml) => qpyodideRenderHtmlOutput(targetDiv, animHtml));
  (result.animationErrors || []).forEach((msg) => {
    // Figur bleibt in diesem Fall als PNG erhalten – erwartete Abstufung.
    if (msg) console.warn("qpyodide: Animation nicht darstellbar –", msg);
  });

  const hasImages = qpyodideRenderImages(targetDiv, result.images, options["fig-cap"]);
  targetDiv.classList.toggle("has-content", hasImages || animations.length > 0);

  const images  = result.images  || [];
  const pickles = result.pickles || [];
  if (images.length === 0) return;
  if (result.html) return;
  if (!globalThis.qpyodideCanvasWanted?.(options)) return;

  if (pickles.length !== images.length || pickles.some((p) => !p)) {
    // Mindestens eine Figur ließ sich nicht pickeln -> beim Bild bleiben,
    // sonst stünden Canvas und PNG gemischt untereinander.
    (result.pickleErrors || []).forEach((msg) => {
      if (msg) console.warn("qpyodide: Figur nicht pickelbar –", msg);
    });
    return;
  }

  // Absichtlich ohne await: die Zelle ist fertig, das Nachladen der
  // zweiten Instanz darf im Hintergrund laufen.
  globalThis.qpyodideCanvasUpgrade(targetDiv, pickles, options);
}

/**
 * Rich-HTML-Ausgabe rendern – inkl. Ausführung eingebetteter <script>-Tags
 * (nötig für den matplotlib-to_jshtml-Player). Der Container muss dazu
 * bereits im Dokument hängen.
 */
async function qpyodideRenderHtmlOutput(targetDiv, html) {
  const wrapper = document.createElement("div");
  wrapper.className = "qpyodide-html-output";
  targetDiv.appendChild(wrapper);
  wrapper.innerHTML = html;

  // innerHTML führt Skripte nicht aus -> durch ausführbare Klone ersetzen.
  // Reihenfolge zählt: eine Bibliothek mit src (z. B. d3) muss fertig geladen
  // sein, bevor ein nachfolgendes Inline-Skript sie benutzt. Deshalb der Reihe
  // nach durchgehen und externe Skripte abwarten (Fehler nicht blockieren).
  const scripts = Array.from(wrapper.querySelectorAll("script"));
  for (const oldScript of scripts) {
    const newScript = document.createElement("script");
    for (const attr of oldScript.attributes) {
      newScript.setAttribute(attr.name, attr.value);
    }
    newScript.textContent = oldScript.textContent;
    const loaded = newScript.src
      ? new Promise((resolve) => {
          newScript.addEventListener("load", resolve, { once: true });
          newScript.addEventListener("error", resolve, { once: true });
        })
      : null;
    oldScript.replaceWith(newScript);
    if (loaded) await loaded;
  }
}

// ---------------------------------------------------------------------------
// EditorUnit – ein Monaco-Editor mit Toolbar und Ausgabe-Bereichen
// ---------------------------------------------------------------------------

class EditorUnit {
  /**
   * @param {Object} config
   * @param {string}  config.uid       eindeutige ID (z. B. "3" oder "3.2")
   * @param {string}  config.code      Anfangs-Code des Editors
   * @param {Object}  config.options   Zell-Optionen (read-only, fig-cap, …)
   * @param {Element} config.hostDiv   Container, in den die Einheit gebaut wird
   */
  constructor({ uid, code, options, hostDiv }) {
    this.uid = uid;
    this.code = code;
    this.options = options;
    this.hostDiv = hostDiv;
    this.editor = null;
    this.isReadOnly = options["read-only"] === "true";
    this.lastRunCode = null;   // Code-Stand des letzten Laufs
    this.lastOutput = null;    // Textausgabe des letzten Laufs (für Feedback-Cache)

    this.buildDom();
    this.initMonaco();
    this.wireButtons();
  }

  /** Toolbar + Editor- und Ausgabe-Bereiche aufbauen. */
  buildDom() {
    const uid = this.uid;

    // Toolbar
    this.toolbarDiv = document.createElement("div");
    this.toolbarDiv.className = "qpyodide-editor-toolbar " +
      (this.isReadOnly ? "qpyodide-toolbar-readonly" : "qpyodide-toolbar-editable");
    this.toolbarDiv.id = `qpyodide-editor-toolbar-${uid}`;

    const leftButtonsDiv = document.createElement("div");
    leftButtonsDiv.className = "qpyodide-editor-toolbar-left-buttons";

    const middleToolBarDiv = document.createElement("div");
    middleToolBarDiv.className = "qpyodide-editor-toolbar-middle";

    const rightButtonsDiv = document.createElement("div");
    rightButtonsDiv.className = "qpyodide-editor-toolbar-right-buttons";

    // Run-Button
    this.runButton = document.createElement("button");
    this.runButton.className = "btn btn-default qpyodide-button qpyodide-button-run";
    this.runButton.type = "button";
    this.runButton.id = `qpyodide-button-run-${uid}`;
    this.runButton.title = QP_L.runTitle;
    if (globalThis.mainPyodide) {
      this.runButton.innerHTML = QP_L.runLabel;
      this.runButton.disabled = false;
    } else {
      this.runButton.textContent = QP_L.runLoading;
      this.runButton.disabled = true;
    }
    leftButtonsDiv.appendChild(this.runButton);

    // Editierbar/Schreibgeschützt-Label
    const readOnlyLabel = document.createElement("label");
    readOnlyLabel.className = "qpyodide-label qpyodide-readonly-label";
    readOnlyLabel.id = `qpyodide-readonly-label-${uid}`;
    readOnlyLabel.textContent = this.isReadOnly ? QP_L.labelReadOnly : QP_L.labelEditable;
    middleToolBarDiv.appendChild(readOnlyLabel);

    // Reset-Button
    this.resetButton = document.createElement("button");
    this.resetButton.className = "btn btn-light btn-xs qpyodide-button qpyodide-button-reset";
    this.resetButton.type = "button";
    this.resetButton.id = `qpyodide-button-reset-${uid}`;
    this.resetButton.title = QP_L.resetTitle;
    this.resetButton.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i>';
    rightButtonsDiv.appendChild(this.resetButton);

    // Copy-Button
    this.copyButton = document.createElement("button");
    this.copyButton.className = "btn btn-light btn-xs qpyodide-button qpyodide-button-copy";
    this.copyButton.type = "button";
    this.copyButton.id = `qpyodide-button-copy-${uid}`;
    this.copyButton.title = QP_L.copyTitle;
    this.copyButton.innerHTML = '<i class="fa-regular fa-copy"></i>';
    rightButtonsDiv.appendChild(this.copyButton);

    // Feedback-Button (nur bei aktiviertem Feature und editierbaren Zellen)
    this.feedbackButton = null;
    if (globalThis.qpyodideFeedback?.enabled && !this.isReadOnly) {
      this.feedbackButton = document.createElement("button");
      this.feedbackButton.className = "btn btn-default qpyodide-button qpyodide-button-feedback";
      this.feedbackButton.type = "button";
      this.feedbackButton.id = `qpyodide-button-feedback-${uid}`;
      this.feedbackButton.title = QP_L.feedbackTitle;
      this.feedbackButton.innerHTML = QP_L.feedbackLabel;
      this.feedbackButton.disabled = !globalThis.mainPyodide;
      rightButtonsDiv.appendChild(this.feedbackButton);
    }

    this.toolbarDiv.appendChild(leftButtonsDiv);
    this.toolbarDiv.appendChild(middleToolBarDiv);
    this.toolbarDiv.appendChild(rightButtonsDiv);

    // Konsole: Editor + Text-Ausgabe + Feedback-Ausgabe
    const consoleAreaDiv = document.createElement("div");
    consoleAreaDiv.id = `qpyodide-console-area-${this.uid}`;
    consoleAreaDiv.className = "qpyodide-console-area";

    this.editorDiv = document.createElement("div");
    this.editorDiv.id = `qpyodide-editor-${uid}`;
    this.editorDiv.className = "qpyodide-editor";

    this.outputCodeDiv = document.createElement("div");
    this.outputCodeDiv.id = `qpyodide-output-code-area-${uid}`;
    this.outputCodeDiv.className = "qpyodide-output-code-area";
    this.outputCodeDiv.setAttribute("aria-live", "assertive");
    const placeholderPre = document.createElement("pre");
    placeholderPre.style.visibility = "hidden";
    this.outputCodeDiv.appendChild(placeholderPre);

    this.outputFeedbackDiv = document.createElement("div");
    this.outputFeedbackDiv.id = `qpyodide-output-feedback-area-${uid}`;
    this.outputFeedbackDiv.className = "qpyodide-output-feedback-area";
    this.outputFeedbackDiv.setAttribute("aria-live", "assertive");

    consoleAreaDiv.appendChild(this.editorDiv);
    consoleAreaDiv.appendChild(this.outputCodeDiv);
    if (this.feedbackButton) {
      consoleAreaDiv.appendChild(this.outputFeedbackDiv);
    }

    // Grafik-Ausgabe (matplotlib)
    this.outputGraphDiv = document.createElement("div");
    this.outputGraphDiv.id = `qpyodide-output-graph-area-${uid}`;
    this.outputGraphDiv.className = "qpyodide-output-graph-area";

    // Hinweis für input()-Zellen, wenn input() (noch) nicht verfügbar ist.
    // Standardmäßig versteckt; updateInputGate() blendet ihn bei Bedarf ein.
    this.inputHintDiv = document.createElement("div");
    this.inputHintDiv.className = "qpyodide-cell-input-hint";
    this.inputHintDiv.hidden = true;

    this.hostDiv.appendChild(this.toolbarDiv);
    this.hostDiv.appendChild(this.inputHintDiv);
    this.hostDiv.appendChild(consoleAreaDiv);
    this.hostDiv.appendChild(this.outputGraphDiv);

    // Erstes Gate anhand des Anfangs-Codes (Editor existiert noch nicht;
    // getCode() fällt auf this.code zurück).
    this.updateInputGate();
  }

  /** Monaco-Editor erzeugen (Höhe, EOL, Tastatur-Kürzel). */
  initMonaco() {
    const thiz = this;

    require(["vs/editor/editor.main"], function () {
      thiz.editor = monaco.editor.create(thiz.editorDiv, {
        value: thiz.code,
        language: "python",
        theme: qpyodideMonacoTheme(),
        automaticLayout: true,           // Works wonderfully with RevealJS
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        fontSize: "17.5pt",              // Bootstrap is 1 rem
        renderLineHighlight: "none",     // Disable current line highlighting
        hideCursorInOverviewRuler: true, // Remove cursor indicator in scroll bar
        readOnly: thiz.isReadOnly
      });

      // Metadaten am Editor hinterlegen (z. B. für andere Extensions)
      thiz.editor.__qpyodideCounter = thiz.uid;
      thiz.editor.__qpyodideEditorId = `qpyodide-editor-${thiz.uid}`;
      thiz.editor.__qpyodideinitialCode = thiz.code;
      thiz.editor.__qpyodideOptions = thiz.options;

      // Set at the model level the preferred end of line (EOL) character to LF.
      // This prevents `\r\n` from being given to the Pyodide engine on Windows.
      // See details in: https://github.com/coatless/quarto-Pyodide/issues/94
      const model = thiz.editor.getModel();
      model.setEOL(monaco.editor.EndOfLineSequence.LF);

      // Editor-Höhe dynamisch an den Inhalt anpassen
      const updateHeight = () => {
        const contentHeight = thiz.editor.getContentHeight();
        thiz.editorDiv.style.height = `${contentHeight}px`;
        thiz.editor.layout();
      };

      const isEmptyCodeText = (selected) =>
        (selected === null || selected === undefined || selected === "");

      // Tastatur-Kürzel müssen beim Fokuswechsel je Editor neu registriert
      // werden (Monaco-Regression seit 0.32.0):
      // https://github.com/microsoft/monaco-editor/issues/2947
      const addPyodideKeyboardShortCutCommands = () => {
        // Shift+Enter: gesamten Zell-Inhalt ausführen
        thiz.editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
          thiz.runCode(thiz.editor.getValue());
        });

        // Ctrl/Cmd+Enter: Auswahl (oder aktuelle Zeile) ausführen
        thiz.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
          const selectedText = thiz.editor.getModel()
            .getValueInRange(thiz.editor.getSelection());

          if (isEmptyCodeText(selectedText)) {
            const currentPosition = thiz.editor.getPosition();
            const currentLine = thiz.editor.getModel()
              .getLineContent(currentPosition.lineNumber);

            const newPosition = new monaco.Position(currentPosition.lineNumber + 1, 1);
            if (newPosition.lineNumber > thiz.editor.getModel().getLineCount()) {
              thiz.editor.executeEdits("addNewLine", [{
                range: new monaco.Range(newPosition.lineNumber, 1, newPosition.lineNumber, 1),
                text: "\n",
                forceMoveMarkers: true,
              }]);
            }

            thiz.runCode(currentLine);
            thiz.editor.setPosition(newPosition);
          } else {
            thiz.runCode(selectedText);
          }
        });
      };

      thiz.editor.onDidFocusEditorText(addPyodideKeyboardShortCutCommands);
      thiz.editor.onDidContentSizeChange(updateHeight);
      // Code-Änderungen können input() ein-/ausbauen -> Gate neu bewerten
      thiz.editor.onDidChangeModelContent(() => thiz.updateInputGate());
      updateHeight();
      thiz.updateInputGate();
    });
  }

  /** Button-Klicks verdrahten (Run/Reset/Copy/Feedback). */
  wireButtons() {
    const thiz = this;

    this.runButton.onclick = () => thiz.runCode(thiz.getCode());

    this.copyButton.onclick = () => {
      navigator.clipboard.writeText(thiz.getCode() || "");
    };

    this.resetButton.onclick = () => {
      if (thiz.editor) {
        thiz.editor.setValue(thiz.editor.__qpyodideinitialCode);
      }
      thiz.lastRunCode = null;
      thiz.lastOutput = null;
      [thiz.outputCodeDiv, thiz.outputFeedbackDiv, thiz.outputGraphDiv].forEach((div) => {
        if (div.classList.contains("has-content")) {
          div.innerHTML = "";
          div.classList.remove("has-content");
        }
      });
    };

    // KI-Feedback: die gesamte Logik lebt in qpyodide-feedback.js
    if (this.feedbackButton) {
      qpyodideFeedback.attach({
        uid: this.uid,
        feedbackButton: this.feedbackButton,
        feedbackDiv: this.outputFeedbackDiv,
        getCode: () => thiz.getCode(),
        runForOutput: () => thiz.runForOutput()
      });
    }

    // input()-Gate aktuell halten: bei Zustandswechsel (input() geprüft/aktiviert)
    // und einmal, sobald die Pyodide-Runtime bereitsteht.
    window.addEventListener("qpyodide-input-state", () => thiz.updateInputGate());
    if (globalThis.qpyodideReady) {
      globalThis.qpyodideReady.then(() => thiz.updateInputGate()).catch(() => {});
    }
  }

  /** Aktuellen Code des Editors holen (Fallback: Anfangs-Code). */
  getCode() {
    return this.editor ? this.editor.getValue() : this.code;
  }

  /**
   * Sperrt/entsperrt den Run-Knopf abhängig davon, ob die Zelle input() nutzt
   * und ob input() auf dieser Seite verfügbar ist. Blendet bei Bedarf einen
   * Inline-Hinweis mit Link auf das input()-Panel oben ein.
   */
  updateInputGate() {
    if (!this.runButton) return;

    const needsInput = qpyodideCodeHasInput(this.getCode());
    const available  = globalThis.qpyodideInputAvailable
      ? globalThis.qpyodideInputAvailable() : true;

    // Marker für die globalen Toggler (qpyodideSetRunButtonsEnabled,
    // qpyodideSetInteractiveButtonState), damit sie die Sperre respektieren.
    if (needsInput) {
      this.runButton.dataset.needsInput = "1";
    } else {
      delete this.runButton.dataset.needsInput;
    }

    const blocked = needsInput && !available;

    // Den Run-Knopf nur anfassen, wenn Python bereit ist und gerade nichts
    // läuft – sonst würden wir den Lade- oder Stopp-Zustand überschreiben.
    if (globalThis.mainPyodide && !qpyodideExecutionBusy) {
      this.runButton.disabled = blocked;
      this.runButton.title = blocked
        ? QP_L.runTitleBlocked
        : QP_L.runTitle;
    }

    // Inline-Hinweis auf-/zuklappen
    if (!this.inputHintDiv) return;
    if (!blocked) {
      this.inputHintDiv.hidden = true;
      this.inputHintDiv.innerHTML = "";
      return;
    }

    const hints = {
      "unavailable":  QP_L.cellInputHintUnavailable,
      "needs-reload": QP_L.cellInputHintNeedsReload,
    };
    this.inputHintDiv.innerHTML =
      hints[globalThis.qpyodideInputState] || QP_L.cellInputHintCheck;
    this.inputHintDiv.hidden = false;
  }

  /**
   * Code im Worker ausführen und Ergebnis (Text/HTML/Plots) unterhalb des
   * Editors anzeigen. Während der Ausführung wird der Run-Button dieser
   * Zelle zum Stopp-Knopf (sanfter Abbruch via Interrupt, sonst harter
   * Worker-Neustart) – die Seite bleibt dabei voll bedienbar.
   * @returns {Promise<string>} die Text-Ausgabe des Interpreters
   */
  async runCode(code) {
    if (qpyodideExecutionBusy) return "";
    qpyodideExecutionBusy = true;
    qpyodideSetRunButtonsEnabled(false);

    const proxy = await qpyodideReady;

    // Streaming-Terminal anlegen (läuft für alle Zellen, nicht nur bei input())
    this.outputCodeDiv.innerHTML = "";
    const terminalDiv = document.createElement("div");
    terminalDiv.className = "qpyodide-terminal";
    this.outputCodeDiv.appendChild(terminalDiv);
    this.outputCodeDiv.classList.add("has-content");

    // Gestreamter stdout/stderr: jede Zeile erscheint sofort im Terminal
    proxy.onStream = (text, type) => {
      const line = document.createElement("code");
      line.className = type === "stderr"
        ? "qpyodide-output-code-stderr"
        : "qpyodide-output-code-stdout";
      line.textContent = text;
      terminalDiv.appendChild(line);
      terminalDiv.appendChild(document.createTextNode("\n"));
    };

    // Python-input(): Eingabefeld inline ins Terminal einfügen und dann blockieren
    // (funktioniert nur wenn die Seite cross-origin-isoliert ist)
    // prompt kommt direkt vom Worker (via _qpyodide_set_prompt aus Python),
    // da Pyodide stdout nur bei vollständigen Zeilen (mit \n) flusht –
    // input()-Prompts ohne \n würden sonst nie den Main-Thread erreichen.
    proxy.onInputRequired = (prompt) => {
      const row = document.createElement("div");
      row.className = "qpyodide-input-row";

      if (prompt) {
        const promptSpan = document.createElement("span");
        promptSpan.className = "qpyodide-input-prompt";
        promptSpan.textContent = prompt;
        row.appendChild(promptSpan);
      }

      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "qpyodide-terminal-input";
      inp.setAttribute("autocomplete", "off");
      inp.setAttribute("spellcheck", "false");
      row.appendChild(inp);
      terminalDiv.appendChild(row);
      inp.focus();

      inp.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const val = inp.value;
        // Eingabefeld durch Echo ersetzen (Prompt-Label bleibt erhalten)
        const echo = document.createElement("code");
        echo.className = "qpyodide-output-code-stdout qpyodide-input-echo";
        echo.textContent = val;
        inp.replaceWith(echo);
        terminalDiv.appendChild(document.createTextNode("\n"));
        // Wert an den Worker übergeben (weckt Atomics.wait in stdin())
        proxy.provideInput(val);
      });
    };

    // Run-Button in Stopp-Knopf verwandeln
    const runButtonHtml = this.runButton.innerHTML;
    this.runButton.innerHTML = QP_L.stopLabel;
    this.runButton.title = proxy.interruptBuffer
      ? QP_L.stopTitle
      : QP_L.stopTitleRestart;
    this.runButton.disabled = false;
    this.runButton.onclick = () => {
      // Offenes Eingabefeld als "[Abgebrochen]" markieren
      terminalDiv.querySelectorAll(".qpyodide-input-row").forEach((row) => {
        const aborted = document.createElement("code");
        aborted.className = "qpyodide-output-code-stderr";
        aborted.textContent = QP_L.aborted;
        row.replaceChildren(aborted);
      });
      if (proxy.interruptBuffer) {
        proxy.interrupt();
      } else {
        proxy.restart(QP_L.abortedRestart);
      }
    };

    let text = "";
    try {
      const result = await qpyodideExecutePython(
        code, globalThis.qpyodideCanvasWanted?.(this.options)
      );
      text = result.text;

      // HTML-Rückgabe (z. B. Animation) und Grafiken anhängen
      if (result.html) qpyodideRenderHtmlOutput(this.outputCodeDiv, result.html);
      this.outputGraphDiv.innerHTML = "";
      qpyodideRenderPlots(this.outputGraphDiv, result, this.options);

      // Terminal leer + kein HTML → has-content entfernen (kein Platz verschwenden)
      if (!terminalDiv.hasChildNodes() && !result.html) {
        this.outputCodeDiv.classList.remove("has-content");
      }
    } catch (err) {
      // Harter Abbruch (Worker-Neustart) oder Worker-Absturz
      text = String((err && err.message) || err);
      terminalDiv.querySelectorAll(".qpyodide-input-row").forEach((r) => r.remove());
      const errCode = document.createElement("code");
      errCode.className = "qpyodide-output-code-stderr";
      errCode.textContent = text;
      terminalDiv.appendChild(errCode);
    } finally {
      proxy.onStream = null;
      proxy.onInputRequired = null;
      proxy.clearInterrupt();
      this.runButton.innerHTML = runButtonHtml;
      this.runButton.title = QP_L.runTitle;
      this.runButton.onclick = () => this.runCode(this.getCode());
      qpyodideExecutionBusy = false;
      qpyodideSetRunButtonsEnabled(true);
    }
    this.lastRunCode = code;
    this.lastOutput  = text;
    return text;
  }

  /** Für das Feedback: Interpreter-Ausgabe des letzten Laufs liefern.
   *  Feedback führt den Code NIE selbst aus – das bleibt immer dem Nutzer überlassen.
   *  So sieht das KI-Feedback immer genau das, was der Nutzer auch gesehen hat. */
  async runForOutput() {
    const currentCode = this.getCode();
    if (this.lastOutput !== null && this.lastRunCode === currentCode) {
      return this.lastOutput;
    }
    if (this.lastOutput !== null) {
      // Code wurde seit dem letzten Lauf verändert
      return QP_L.outputChanged;
    }
    // Code wurde noch nie ausgeführt
    const hasInput = qpyodideCodeHasInput(currentCode);
    if (hasInput) {
      return QP_L.outputNeedsInput;
    }
    return QP_L.outputNotRun;
  }
}

// ---------------------------------------------------------------------------
// Zell-Klassen
// ---------------------------------------------------------------------------

/**
 * BaseCell – gemeinsame Basis aller Zell-Typen.
 */
class BaseCell {
  constructor(cellData) {
    this.code = cellData.code;
    this.id = cellData.id;
    this.options = cellData.options;
    this.insertionLocation = document.getElementById(
      `qpyodide-insertion-location-${this.id}`
    );
  }

  /** Wird nach dem Pyodide-Start vom CellContainer aufgerufen. */
  async runStartup() { /* Standard: nichts zu tun */ }
}

/**
 * InteractiveCell – einklappbare Zelle mit einer (oder per „+ Codeblock"
 * zwei) EditorUnit(s).
 */
class InteractiveCell extends BaseCell {
  constructor(cellData) {
    super(cellData);
    this.units = [];
    this.setupElement();
  }

  setupElement() {
    const mainDiv = document.createElement("div");
    mainDiv.id = `qpyodide-interactive-area-${this.id}`;
    mainDiv.className = "qpyodide-interactive-area";
    if (this.options.classes) {
      mainDiv.className += " " + this.options.classes;
    }
    if (this.options.label) {
      mainDiv.setAttribute("data-id", this.options.label);
    }

    // Einklappbarer Rahmen um die ganze Zelle
    const details = document.createElement("details");
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = QP_L.showPythonCode;
    details.appendChild(summary);

    // Haupteditor
    const unitHost = document.createElement("div");
    details.appendChild(unitHost);
    this.primaryUnit = new EditorUnit({
      uid: String(this.id),
      code: this.code,
      options: this.options,
      hostDiv: unitHost
    });
    this.units.push(this.primaryUnit);

    // „+ Codeblock"-Button: hängt EINEN zusätzlichen, leeren, editierbaren
    // Editor unter die Zelle (nützlich z. B. unter schreibgeschützten
    // Beispielen). Nutzt dieselbe EditorUnit-Klasse – keine Duplikate.
    const addCodeBlockButton = document.createElement("button");
    addCodeBlockButton.className = "btn btn-default qpyodide-button qpyodide-button-codeblock";
    addCodeBlockButton.type = "button";
    addCodeBlockButton.id = `qpyodide-button-codeblock-${this.id}`;
    addCodeBlockButton.title = QP_L.addCodeBlockTitle;
    addCodeBlockButton.innerHTML = QP_L.addCodeBlockLabel;
    this.primaryUnit.toolbarDiv
      .querySelector(".qpyodide-editor-toolbar-right-buttons")
      .appendChild(addCodeBlockButton);

    const thiz = this;
    addCodeBlockButton.onclick = function () {
      const extraHost = document.createElement("div");
      extraHost.className = "qpyodide-extra-codeblock";
      details.appendChild(extraHost);

      const extraOptions = { ...thiz.options, "read-only": "false", "autorun": "" };
      thiz.units.push(new EditorUnit({
        uid: `${thiz.id}.${thiz.units.length + 1}`,
        code: "",
        options: extraOptions,
        hostDiv: extraHost
      }));

      addCodeBlockButton.disabled = true;
    };

    mainDiv.appendChild(details);
    this.insertionLocation.appendChild(mainDiv);
  }

  /** autorun-Option: Code nach dem Pyodide-Start einmal ausführen. */
  async runStartup() {
    if (this.options.autorun === "true") {
      await this.primaryUnit.runCode(this.code);
    }
  }
}

/**
 * OutputCell – führt den Code beim Start aus und zeigt nur die Ausgabe.
 */
class OutputCell extends BaseCell {
  constructor(cellData) {
    super(cellData);
    this.setupElement();
  }

  setupElement() {
    const mainDiv = document.createElement("div");
    mainDiv.id = `qpyodide-noninteractive-area-${this.id}`;
    mainDiv.className = "qpyodide-non-interactive-area";
    if (this.options.classes) {
      mainDiv.className += " " + this.options.classes;
    }
    if (this.options.label) {
      mainDiv.setAttribute("data-id", this.options.label);
    }

    // Lade-Hinweis, bis der Code beim Start ausgeführt wurde
    this.loadingContainer = document.createElement("div");
    this.loadingContainer.className =
      "qpyodide-non-interactive-loading-container qpyodide-cell-needs-evaluation";
    const statusText = document.createElement("p");
    statusText.className = "qpyodide-status-text qpyodide-cell-needs-evaluation";
    statusText.innerText = QP_L.runAtStartup;
    this.loadingContainer.appendChild(statusText);
    mainDiv.appendChild(this.loadingContainer);

    this.outputCodeDiv = document.createElement("div");
    this.outputCodeDiv.className = "qpyodide-output-code-area";
    this.outputCodeDiv.setAttribute("aria-live", "assertive");
    mainDiv.appendChild(this.outputCodeDiv);

    this.outputGraphDiv = document.createElement("div");
    this.outputGraphDiv.className = "qpyodide-output-graph-area";
    mainDiv.appendChild(this.outputGraphDiv);

    this.insertionLocation.appendChild(mainDiv);
  }

  // Idempotent: läuft nach einem harten Worker-Neustart erneut, ohne
  // Ausgaben zu duplizieren.
  async runStartup() {
    const result = await qpyodideExecutePython(
      this.code, globalThis.qpyodideCanvasWanted?.(this.options)
    );

    this.loadingContainer.remove();
    this.outputCodeDiv.innerHTML = "";
    this.outputGraphDiv.innerHTML = "";

    const hasText = qpyodideRenderTextOutput(this.outputCodeDiv, result.entries);
    if (result.html) {
      qpyodideRenderHtmlOutput(this.outputCodeDiv, result.html);
    }
    this.outputCodeDiv.classList.toggle("has-content", hasText || !!result.html);

    qpyodideRenderPlots(this.outputGraphDiv, result, this.options);
  }
}

/**
 * SetupCell – führt den Code beim Start unsichtbar aus.
 */
class SetupCell extends BaseCell {
  async runStartup() {
    // Ausgabe und eventuelle Plots werden bewusst verworfen
    await qpyodideExecutePython(this.code);
  }
}

// ---------------------------------------------------------------------------
// Container + Fabrik
// ---------------------------------------------------------------------------

/**
 * CellContainer – verwaltet alle Zellen in Dokument-Reihenfolge.
 */
class CellContainer {
  constructor() {
    this.cells = [];
  }

  addCell(cell) {
    this.cells.push(cell);
  }

  /**
   * Startphase nach dem Pyodide-Boot: erst alle setup-Zellen, dann
   * output-Zellen, zuletzt interactive-Zellen mit autorun.
   */
  async runStartupCells() {
    const order = { setup: 0, output: 1, interactive: 2 };
    const sorted = this.cells.slice().sort((a, b) =>
      (order[a.options.context] ?? 2) - (order[b.options.context] ?? 2)
    );
    for (const cell of sorted) {
      try {
        await cell.runStartup();
      } catch (err) {
        console.error(`qpyodide: Startphase von Zelle ${cell.id} fehlgeschlagen`, err);
      }
    }
  }
}

/**
 * Factory function to create different types of cells based on options.
 * @param {Object} cellData - JSON object containing code, id, and options.
 * @returns {BaseCell} Instance of the appropriate cell class.
 */
globalThis.qpyodideCreateCell = function(cellData) {
  switch (cellData.options.context) {
    case "interactive":
      return new InteractiveCell(cellData);
    case "output":
      return new OutputCell(cellData);
    case "setup":
      return new SetupCell(cellData);
    default:
      return new InteractiveCell(cellData);
  }
}

// Globaler Container, den qpyodide-cell-initialization.js befüllt
globalThis.qpyodideCellContainer = new CellContainer();
