// qpyodide-document-engine-initialization.js – Pyodide im Web Worker starten
//
// Kernidee: Python läuft in einem eigenen Thread (Web Worker). Die Seite
// bleibt dadurch während der Ausführung voll bedienbar – auch bei langen
// Berechnungen. Der Worker wird als Blob-Modul-Worker direkt aus dieser
// Datei heraus erzeugt (die Extension injiziert nur Inline-Skripte).
//
// Abbrechen einer laufenden Ausführung:
//   * Seite cross-origin-isoliert (COOP/COEP-Header gesetzt):
//     sanfter Abbruch via SharedArrayBuffer + setInterruptBuffer
//     (KeyboardInterrupt, Variablen bleiben erhalten).
//   * sonst: harter Neustart des Workers (Variablen gehen verloren,
//     setup-/output-/autorun-Zellen laufen danach erneut).
//
// Globale Schnittstellen für andere Module/Extensions:
//   qpyodideReady    – Promise, das mit dem Pyodide-Proxy auflöst
//   qpyodideInstance – Alias auf dasselbe Promise (Kompatibilität, wird
//                      z. B. von Erasmus-CTM/py-exercise verwendet)
//   mainPyodide      – der Proxy (gesetzt sobald der Worker bereit ist);
//                      bietet runPythonAsync, loadPackagesFromImports,
//                      loadPackage, globals.set und toPy als RPC-Varianten

// ---------------------------------------------------------------------------
// Worker-Quelltext (läuft im Hintergrund-Thread)
// ---------------------------------------------------------------------------
// Wichtig: String.raw, damit Escape-Sequenzen unverändert im Worker ankommen.
// Im Worker-Quelltext keine Backticks und kein "Dollar-geschweifte-Klammer"
// verwenden!

const qpyodideWorkerSource = String.raw`
// Pyodide-Worker der Extension pyodide-interaktiv
let pyodide = null;
let runEntries = [];

// Eingabe-Puffer fuer Atomics-basiertes stdin (null wenn nicht verfuegbar)
let inputStatusBuf = null;   // Int32Array(SharedArrayBuffer) 0=idle 1=warten 2=bereit 3=abgebrochen
let inputDataBuf   = null;   // Uint8Array(SharedArrayBuffer) UTF-8-kodierte Eingabe (null-terminiert)

// Prompt-Text des naechsten input()-Aufrufs (wird von Python via _qpyodide_set_prompt gesetzt)
let pendingInputPrompt = "";
self._qpyodide_set_prompt = (p) => { pendingInputPrompt = String(p); };

// Python-Setup: matplotlib auf AGG (PNG-Rendering ohne DOM), plt.show() als
// Ausloeser der Ausgabe wie in einem lokalen Skript, Figur-Sammler und der
// Helfer zeige_animation() fuer Sonderfaelle wie GIF-Ausgabe.
const PY_SETUP = [
  "import matplotlib",
  "matplotlib.use('AGG')",
  "from matplotlib import pyplot as plt",
  "",
  "# Animationen mitschreiben. Ohne GUI gibt es keinen Timer, der eine",
  "# FuncAnimation antreibt - beim Anzeigen muss sie deshalb zum JS-Player",
  "# werden statt zum Standbild. Dafuer muss zu einer Figur die zugehoerige",
  "# Animation auffindbar sein, und matplotlib fuehrt darueber kein Register.",
  "# Angehaengt wird an Animation.__init__, damit FuncAnimation und",
  "# ArtistAnimation gleichermassen erfasst sind (beide rufen es ueber",
  "# super() auf). Der Eintrag haelt die Animation ausserdem am Leben - sonst",
  "# warnt matplotlib 'Animation was deleted without rendering anything',",
  "# wenn niemand sie einer Variablen zuweist.",
  "import matplotlib.animation as _qanim",
  "_qpyodide_animations = []",
  "def _qpyodide_anim_init(self, *args, _orig=_qanim.Animation.__init__, **kwargs):",
  "    _orig(self, *args, **kwargs)",
  "    _qpyodide_animations.append(self)",
  "_qanim.Animation.__init__ = _qpyodide_anim_init",
  "del _qanim, _qpyodide_anim_init",
  "",
  "# Anzeige exakt wie in einem lokalen Skript: plt.show() ist der Ausloeser.",
  "# Ohne Aufruf wird nichts ausgegeben, mit Aufruf erscheint alles, was",
  "# gerade offen ist. Die gezeigten Figuren werden dabei geschlossen - lokal",
  "# beendet genau das (das Schliessen der Fenster) ein blockierendes show(),",
  "# und ein darauf folgendes plt.plot() beginnt eine neue Figur statt in die",
  "# alte zu zeichnen.",
  "# Der eigene show()-Ersatz ist ohnehin noetig: AGG ist nicht interaktiv,",
  "# das echte plt.show() wuerde nichts tun ausser zu warnen.",
  "_qpyodide_shown       = []   # Figuren, die als PNG ausgegeben werden",
  "_qpyodide_shown_anims = []   # bereits gerenderte Animations-Player (HTML)",
  "_qpyodide_anim_errors = []",
  "",
  "def _qpyodide_show_figure(fig):",
  "    # Haengt an der Figur eine Animation, wird sie zum JS-Player. Scheitert",
  "    # das, faellt die Figur auf den normalen PNG-Weg zurueck - dieselbe",
  "    # Abstufung wie bei den pickles.",
  "    for ani in _qpyodide_animations:",
  "        if getattr(ani, '_fig', None) is not fig:",
  "            continue",
  "        try:",
  "            _qpyodide_shown_anims.append(ani.to_jshtml())",
  "            plt.close(fig)",
  "            return",
  "        except Exception as exc:",
  "            _qpyodide_anim_errors.append(type(exc).__name__ + ': ' + str(exc))",
  "            break",
  "    _qpyodide_shown.append(fig)",
  "    plt.close(fig)",
  "",
  "def _qpyodide_show(*args, **kwargs):",
  "    # get_fignums() liefert eine Kopie, das Schliessen in der Schleife ist",
  "    # also unproblematisch.",
  "    for num in plt.get_fignums():",
  "        _qpyodide_show_figure(plt.figure(num))",
  "plt.show = _qpyodide_show",
  "",
  "# fig.show() zeigt nur diese eine Figur (im Skript nicht blockierend).",
  "import matplotlib.figure as _qfigmod",
  "def _qpyodide_figure_show(self, *args, **kwargs):",
  "    _qpyodide_show_figure(self)",
  "_qfigmod.Figure.show = _qpyodide_figure_show",
  "del _qfigmod, _qpyodide_figure_show",
  "",
  "def _qpyodide_collect_figures(want_pickle=False):",
  "    # Gibt aus, was plt.show() freigegeben hat. Immer als PNG; zusaetzlich",
  "    # als pickle, wenn der Haupt-Thread die Figur interaktiv nachzeichnen",
  "    # will (siehe qpyodide-canvas-plots.js). Reihenfolge: erst pickeln, dann",
  "    # speichern - savefig haengt einen Renderer an die Figur, der nicht",
  "    # mitgepickelt werden soll.",
  "    import base64, io, pickle, warnings",
  "    animations  = list(_qpyodide_shown_anims)",
  "    anim_errors = list(_qpyodide_anim_errors)",
  "    images, pickles, errors = [], [], []",
  "    for fig in _qpyodide_shown:",
  "        if want_pickle:",
  "            try:",
  "                # Matplotlib legt beim Pickeln intern einen itertools-Farbzyklus ab;",
  "                # Python 3.14 warnt dafuer (Pickle-Support entfaellt) - reines",
  "                # Bibliotheks-Rauschen, daher gezielt stummgeschaltet.",
  "                with warnings.catch_warnings():",
  "                    warnings.filterwarnings('ignore', category=DeprecationWarning, message='.*itertools.*')",
  "                    pickles.append(base64.b64encode(pickle.dumps(fig)).decode('ascii'))",
  "                errors.append('')",
  "            except Exception as exc:",
  "                pickles.append('')",
  "                errors.append(type(exc).__name__ + ': ' + str(exc))",
  "        buf = io.BytesIO()",
  "        fig.savefig(buf, format='png', bbox_inches='tight')",
  "        images.append(base64.b64encode(buf.getvalue()).decode('ascii'))",
  "    _qpyodide_shown.clear()",
  "    _qpyodide_shown_anims.clear()",
  "    _qpyodide_anim_errors.clear()",
  "    _qpyodide_animations.clear()",
  "    # Nie angezeigte Figuren verwerfen: ein Zellenlauf entspricht einem",
  "    # Skriptlauf, danach ist der Figuren-Zustand wieder leer. Sonst wuerden",
  "    # sich bei wiederholtem Ausfuehren derselben Zelle Figuren stapeln und",
  "    # ein spaeteres plt.show() gaebe sie alle auf einmal aus.",
  "    plt.close('all')",
  "    return images, pickles, errors, animations, anim_errors",
  "",
  "",
  "# input()-Prompt abfangen: Pyodide puffert stdout zeilenweise, d.h. der",
  "# Prompt (kein \\n) wuerde nie den Main-Thread erreichen. Stattdessen",
  "# schreiben wir ihn via js._qpyodide_set_prompt in eine JS-Variable,",
  "# die stdin() beim naechsten Aufruf ausliest und mit inputRequired schickt.",
  "# _orig wird per Default-Argument bei der Definition gebunden (bleibt",
  "# erhalten auch nachdem die Hilfsnamen aus dem Namespace geloescht sind).",
  "import builtins as _qbt",
  "def _qpyodide_input(prompt='', _orig=_qbt.input):",
  "    import js",
  "    js._qpyodide_set_prompt(str(prompt))",
  "    return _orig('')",
  "_qbt.input = _qpyodide_input",
  "del _qbt, _qpyodide_input",
  "",
  "def zeige_animation(ani, format='jshtml', fps=None):",
  "    # Gibt eine matplotlib-Animation als einbettbares HTML zurueck.",
  "    # Fuer die normale Anzeige nicht noetig - plt.show() gibt eine Animation",
  "    # von sich aus als Player aus (siehe _qpyodide_show_figure). Sinnvoll",
  "    # bleibt der Aufruf, wenn man Format oder Bildrate steuern will.",
  "    # format='jshtml': interaktiver JS-Player (Standard)",
  "    # format='gif'   : animiertes GIF als <img> (benoetigt Paket 'Pillow')",
  "    from matplotlib import pyplot as plt",
  "    if format == 'gif':",
  "        import base64, os, tempfile",
  "        from matplotlib.animation import PillowWriter",
  "        writer = PillowWriter(fps=fps or 10)",
  "        with tempfile.NamedTemporaryFile(suffix='.gif', delete=False) as tmp:",
  "            path = tmp.name",
  "        try:",
  "            ani.save(path, writer=writer)",
  "            with open(path, 'rb') as fh:",
  "                data = base64.b64encode(fh.read()).decode('ascii')",
  "        finally:",
  "            os.remove(path)",
  "        html = '<img src=\"data:image/gif;base64,' + data + '\" alt=\"Animation\"/>'",
  "    else:",
  "        html = ani.to_jshtml(fps=fps) if fps else ani.to_jshtml()",
  "    plt.close(ani._fig)",
  "    return html"
].join("\n");

// stdin: blockiert den Worker-Thread, bis der Nutzer etwas eingibt.
// Wird von Pyodide als stdin-Handler aufgerufen, wenn Python input() ausfuehrt.
// Sendet zuerst eine Aufforderung an den Haupt-Thread, dann wartet der Worker
// per Atomics.wait (blockiert nur den Worker-Thread, nicht die Seite).
// Wenn kein SharedArrayBuffer verfuegbar ist, gibt stdin null (EOF) zurueck.
function stdin() {
  if (!inputStatusBuf || !inputDataBuf) return null;
  const prompt = pendingInputPrompt;
  pendingInputPrompt = "";
  Atomics.store(inputStatusBuf, 0, 1);              // Status: warten
  self.postMessage({ type: "inputRequired", prompt }); // Haupt-Thread benachrichtigen
  Atomics.wait(inputStatusBuf, 0, 1);               // blockieren bis Status != 1
  const status = Atomics.load(inputStatusBuf, 0);
  Atomics.store(inputStatusBuf, 0, 0);              // Status: idle
  if (status !== 2) return null;                    // abgebrochen (Status 3) -> EOF
  let end = 0;
  while (end < inputDataBuf.length && inputDataBuf[end] !== 0) end++;
  return new TextDecoder().decode(inputDataBuf.slice(0, end)) + "\n";
}

function postStatus(text) {
  self.postMessage({ type: "status", text: text });
}

// Sieht ein Rueckgabewert nach (ganzem) HTML aus?
function looksLikeHtml(text) {
  const trimmed = text.trim();
  return trimmed.startsWith("<") && /<\/?[a-zA-Z][^>]*>/.test(trimmed) && trimmed.endsWith(">");
}

async function init(config) {
  // Uebersetzte Statustexte kommen vom Hauptthread mit (der Worker kennt QP_L nicht)
  const msg = config.messages || {};
  const mod = await import(config.indexURL + "pyodide.mjs");

  postStatus(msg.workerLoading || "Loading Python (Pyodide) ...");
  pyodide = await mod.loadPyodide({
    indexURL: config.indexURL,
    env: config.env,
    stdin: stdin,
    stdout: function(text) {
      runEntries.push({ message: text, type: "stdout" });
      self.postMessage({ type: "streamStdout", text: text });
    },
    stderr: function(text) {
      runEntries.push({ message: text, type: "stderr" });
      self.postMessage({ type: "streamStderr", text: text });
    }
  });

  postStatus(msg.workerInitPackages || "Initialising Python packages ...");
  await pyodide.loadPackage("micropip");

  // Vom Dokument angeforderte Pakete (pyodide: packages: [...])
  if (config.packages && config.packages.length > 0) {
    postStatus(msg.workerExtraPackages || "Installing additional packages ...");
    const micropip = pyodide.pyimport("micropip");
    await micropip.install(config.packages);
    micropip.destroy();
  }

  // requests/urllib3 shimmen (synchrone XHR sind im Worker erlaubt)
  await pyodide.loadPackage("pyodide_http");
  await pyodide.runPythonAsync("import pyodide_http\npyodide_http.patch_all()");

  await pyodide.loadPackage("matplotlib");
  await pyodide.runPythonAsync(PY_SETUP);
}

// Eine Dokument-Zelle ausfuehren: Ausgabe sammeln, HTML-Rueckgabe erkennen,
// animierte Figuren als JS-Player und die uebrigen offenen matplotlib-Figuren
// als PNG (base64) einsammeln. Mit wantPickle kommen die PNG-Figuren
// zusaetzlich als pickle mit, damit eine zweite Pyodide-Instanz auf dem
// Haupt-Thread sie interaktiv neu zeichnen kann.
async function runCell(code, wantPickle) {
  runEntries = [];
  let resultValue;
  try {
    await pyodide.loadPackagesFromImports(code);
    resultValue = await pyodide.runPythonAsync(code);
  } catch (err) {
    runEntries.push({ message: String(err), type: "stderr" });
  }

  let html = null;
  if (resultValue !== undefined && resultValue !== null) {
    const asText = String(resultValue);
    if (typeof resultValue === "object" && typeof resultValue.destroy === "function") {
      resultValue.destroy();
    }
    if (looksLikeHtml(asText)) {
      html = asText;
    } else {
      runEntries.push({ message: asText, type: "stdout" });
    }
  }

  let images = [];
  let pickles = [];
  let pickleErrors = [];
  let animations = [];
  let animationErrors = [];
  try {
    const collect = pyodide.globals.get("_qpyodide_collect_figures");
    const proxy = collect(!!wantPickle);
    const collected = proxy.toJs();
    images      = collected[0];
    pickles     = collected[1];
    pickleErrors = collected[2];
    animations  = collected[3];
    animationErrors = collected[4];
    proxy.destroy();
    collect.destroy();
  } catch (err) {
    runEntries.push({ message: "Plot-Export fehlgeschlagen: " + String(err), type: "stderr" });
  }

  return {
    entries: runEntries,
    html: html,
    images: images,
    pickles: pickles,
    pickleErrors: pickleErrors,
    animations: animations,
    animationErrors: animationErrors
  };
}

// Roher Python-Aufruf (RPC-Variante von runPythonAsync, z. B. fuer
// py-exercise). Ergebnis muss structured-clone-faehig sein.
async function runPythonRaw(code) {
  const result = await pyodide.runPythonAsync(code);
  if (result && typeof result.toJs === "function") {
    let value;
    try {
      value = result.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false });
    } catch (err) {
      value = String(result);
    }
    result.destroy();
    return value;
  }
  return result;
}

self.onmessage = async function(event) {
  const msg = event.data;
  try {
    let value = true;
    switch (msg.type) {
      case "init":
        await init(msg.config);
        break;
      case "setInterrupt":
        pyodide.setInterruptBuffer(msg.buffer);
        break;
      case "setInputBuffers":
        inputStatusBuf = msg.inputStatusBuf;
        inputDataBuf   = msg.inputDataBuf;
        break;
      case "runCell":
        value = await runCell(msg.code, msg.wantPickle);
        break;
      case "runPython":
        value = await runPythonRaw(msg.code);
        break;
      case "loadPackagesFromImports":
        await pyodide.loadPackagesFromImports(msg.code);
        break;
      case "loadPackage":
        await pyodide.loadPackage(msg.name);
        break;
      case "setGlobal":
        pyodide.globals.set(msg.name, pyodide.toPy(msg.value));
        break;
      default:
        throw new Error("Unbekannter Befehl: " + msg.type);
    }
    self.postMessage({ type: "result", id: msg.id, value: value });
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
  }
};
`;

// ---------------------------------------------------------------------------
// Haupt-Thread: Worker starten + RPC-Proxy bereitstellen
// ---------------------------------------------------------------------------

function qpyodideBootPyodideWorker() {
  const pending = new Map();
  let nextId = 1;

  const blobUrl = URL.createObjectURL(
    new Blob([qpyodideWorkerSource], { type: "text/javascript" })
  );
  const worker = new Worker(blobUrl, { type: "module" });

  function rpc(type, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ type, id, ...payload });
    });
  }

  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "status")      { qpyodideUpdateStatusHeaderSpinner(msg.text); return; }
    if (msg.type === "streamStdout") { proxy.onStream?.(msg.text, "stdout"); return; }
    if (msg.type === "streamStderr") { proxy.onStream?.(msg.text, "stderr"); return; }
    if (msg.type === "inputRequired") { proxy.onInputRequired?.(msg.prompt ?? ""); return; }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.type === "error") {
      entry.reject(new Error(msg.message));
    } else {
      entry.resolve(msg.value);
    }
  };

  worker.onerror = (event) => {
    console.error("qpyodide: Fehler im Pyodide-Worker", event);
  };

  // Proxy-Objekt: das, was `await qpyodideReady` bzw. `mainPyodide` liefert.
  // Die Pyodide-ähnlichen Methoden sind RPC-Varianten, damit Extensions wie
  // py-exercise weiter funktionieren (postMessage garantiert die Reihenfolge,
  // daher darf z. B. globals.set ohne await vor runPythonAsync stehen).
  const proxy = {
    isWorkerProxy: true,
    interruptBuffer: null,
    inputStatusBuf: null,     // Int32Array(SharedArrayBuffer) – Eingabe-Status
    inputDataBuf: null,       // Uint8Array(SharedArrayBuffer) – Eingabe-Daten (UTF-8)
    onStream: null,           // Callback(text, type) – gestreamter stdout/stderr
    onInputRequired: null,    // Callback() – Python wartet auf Eingabe

    runCell: (code, wantPickle) => rpc("runCell", { code, wantPickle }),
    runPythonAsync: (code) => rpc("runPython", { code }),
    loadPackagesFromImports: (code) => rpc("loadPackagesFromImports", { code }),
    loadPackage: (name) => rpc("loadPackage", { name }),
    toPy: (value) => value,   // Konvertierung passiert Worker-seitig
    globals: {
      set: (name, value) => rpc("setGlobal", { name, value })
    },

    /** Sanfter Abbruch (KeyboardInterrupt) – nur mit SharedArrayBuffer. */
    interrupt() {
      if (this.interruptBuffer) this.interruptBuffer[0] = 2;   // SIGINT
      this.abortInput();
    },
    clearInterrupt() {
      if (this.interruptBuffer) this.interruptBuffer[0] = 0;
    },

    /** Bricht ein laufendes input()-Wait im Worker ab (Status 3 = abgebrochen). */
    abortInput() {
      if (this.inputStatusBuf && Atomics.load(this.inputStatusBuf, 0) === 1) {
        Atomics.store(this.inputStatusBuf, 0, 3);
        Atomics.notify(this.inputStatusBuf, 0, 1);
      }
    },

    /** Übergibt einen Eingabewert an den wartenden Worker (Status 2 = bereit). */
    provideInput(text) {
      if (!this.inputStatusBuf || !this.inputDataBuf) return;
      const encoded = new TextEncoder().encode(text);
      this.inputDataBuf.fill(0);
      this.inputDataBuf.set(encoded.slice(0, this.inputDataBuf.length - 1));
      Atomics.store(this.inputStatusBuf, 0, 2);
      Atomics.notify(this.inputStatusBuf, 0, 1);
    },

    /**
     * Harter Neustart: Worker beenden, alle offenen Aufrufe abbrechen und
     * eine frische Runtime hochfahren (Startzellen laufen erneut).
     */
    restart(reason) {
      worker.terminate();
      const error = new Error(reason || "Python wurde neu gestartet.");
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();

      globalThis.mainPyodide = undefined;
      globalThis.qpyodideReady = qpyodideBootPyodideWorker();
      globalThis.qpyodideInstance = globalThis.qpyodideReady;
      globalThis.qpyodideReady.then(() => {
        return globalThis.qpyodideCellContainer?.runStartupCells();
      }).catch((err) => console.error("qpyodide: Neustart fehlgeschlagen", err));
    }
  };

  return (async () => {
    qpyodideUpdateStatusHeaderSpinner(QP_L.workerLoading);
    const timerStart = performance.now();

    try {
      await rpc("init", {
        config: {
          indexURL: qpyodideCustomizedPyodideOptions.indexURL,
          env: qpyodideCustomizedPyodideOptions.env,
          packages: qpyodideSetupPythonPackages ? qpyodideInstallPythonPackagesList : [],
          messages: {
            workerLoading:       QP_L.workerLoading,
            workerInitPackages:  QP_L.workerInitPackages,
            workerExtraPackages: QP_L.workerExtraPackages
          }
        }
      });
    } catch (err) {
      qpyodideUpdateStatusHeader(QP_L.engineFailed(err.message));
      throw err;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    // Shared-Buffer aktivieren, wenn die Seite cross-origin-isoliert ist.
    // Interrupt-Buffer: sanfter Abbruch (KeyboardInterrupt).
    // Eingabe-Buffer: Atomics-basiertes input() (Python pausiert per Atomics.wait).
    if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined") {
      try {
        proxy.interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
        await rpc("setInterrupt", { buffer: proxy.interruptBuffer });

        proxy.inputStatusBuf = new Int32Array(new SharedArrayBuffer(4));
        proxy.inputDataBuf   = new Uint8Array(new SharedArrayBuffer(4096));
        await rpc("setInputBuffers", {
          inputStatusBuf: proxy.inputStatusBuf,
          inputDataBuf:   proxy.inputDataBuf
        });
      } catch (err) {
        proxy.interruptBuffer = null;
        proxy.inputStatusBuf  = null;
        proxy.inputDataBuf    = null;
        console.warn("qpyodide: Shared-Buffer nicht verfügbar", err);
      }
    }

    globalThis.mainPyodide = proxy;

    qpyodideSetInteractiveButtonState(QP_L.runLabel, true);
    qpyodideUpdateStatusHeader(QP_L.engineReady);

    const elapsed = (performance.now() - timerStart) / 1000;
    console.log(`qpyodide: Pyodide-Worker bereit nach ${elapsed.toFixed(1)}s`);

    return proxy;
  })();
}

globalThis.qpyodideReady = qpyodideBootPyodideWorker();

// Kompatibilitäts-Alias: ältere Extensions (z. B. py-exercise) erwarten
// `qpyodideInstance` und machen darauf ein `await`.
globalThis.qpyodideInstance = qpyodideReady;

// Create a function to retrieve the promise object.
globalThis._qpyodideGetInstance = function() {
  return globalThis.qpyodideInstance;
}
