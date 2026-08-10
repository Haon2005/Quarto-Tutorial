// qpyodide-canvas-plots.js – interaktive matplotlib-Plots per zweiter Pyodide-Instanz
//
// Ausgangslage: Python laeuft in dieser Extension in einem Web Worker. Dort gibt
// es kein DOM, deshalb kann matplotlib nur mit dem AGG-Backend rendern, also
// PNG-Bilder liefern. Das interaktive `html5_canvas_backend` (Werkzeugleiste mit
// Zoom, Pan, Zuruecksetzen, Speichern) malt dagegen direkt auf ein <canvas> und
// braucht damit zwingend den Haupt-Thread.
//
// Zusaetzlich muss das Canvas-Backend selbst reaktiviert werden. In
// matplotlib-pyodide 0.2.3 (was Pyodide 0.27.2 mitliefert) ist die interaktive
// Schicht upstream abgeschaltet - in v0.2.0 war sie noch aktiv, im Changelog
// steht zur Abschaltung nichts. Drei Stellen sind betroffen, alle drei setzt
// QPC_PY_SETUP unten zurueck:
//   1. Im Export-Block von html5_canvas_backend.py sind FigureCanvasHTMLCanvas
//      und FigureManagerHTMLCanvas auskommentiert; aktiv sind die Agg-Klassen,
//      die nur fertige Agg-Pixel ins Canvas blitten. Der Vektor-Renderer
//      RendererHTMLCanvas wird dadurch nie benutzt.
//   2. canvas.manager_class wird nirgends gesetzt. Seit matplotlib 3.6
//      entscheidet aber genau das ueber den Manager, also entsteht sonst ein
//      FigureManagerBase ohne Werkzeugleiste und canvas.toolbar bleibt None.
//   3. In browser_backend.py sind die add_event_listener-Zeilen fuer Maus und
//      Tastatur auskommentiert, und die zugehoerigen Handler rufen mit
//      canvas.motion_notify_event() eine API auf, die matplotlib in 3.8
//      entfernt hat. Ersetzt durch eigene Handler auf Event(...)._process().
//
// Kompromiss dieses Moduls (EXPERIMENT):
//   1. Der Worker rechnet wie bisher und schickt jede offene Figur zusaetzlich
//      zum PNG als `pickle`-Bytes mit (Base64).
//   2. Das PNG wird sofort angezeigt – die Seite wirkt also nicht langsamer.
//   3. Beim ersten Plot der Seite wird im Hintergrund eine zweite, schlanke
//      Pyodide-Instanz auf dem Haupt-Thread geladen (nur matplotlib).
//   4. Sobald sie steht, wird die Figur dort aus dem pickle wiederhergestellt,
//      als Canvas gezeichnet und das PNG ersetzt. Ab dem zweiten Plot passiert
//      das ohne Wartezeit.
//
// Faellt irgendein Schritt aus (kein pickle moeglich, zweite Instanz laedt
// nicht, Wiederherstellung schlaegt fehl), bleibt das PNG stehen – die Seite
// funktioniert dann genau wie vorher.
//
// Bewusst NICHT betroffen:
//   * Animationen: plt.show() gibt eine animierte Figur als JS-Player aus und
//     schliesst sie dabei - fuer sie entsteht also gar kein pickle. Ein
//     zusaetzlicher statischer Plot in derselben Zelle wird weiterhin ganz
//     normal auf Canvas umgestellt.
//   * Der Rich-HTML-Pfad (Plotly, `zeige_svg()`, `zeige_animation()`): diese
//     Zellen geben HTML zurueck und schliessen ihre Figur selbst; bei einer
//     HTML-Rueckgabe wird grundsaetzlich nicht auf Canvas umgeschaltet.
//   * Zellen mit der Option `#| canvas: false`.
//
// Globale Schnittstellen:
//   qpyodideCanvasPlots        – Zustand + Schalter (enabled, status, bootSeconds)
//   qpyodideCanvasWanted(opts) – soll fuer diese Zelle Canvas versucht werden?
//   qpyodideCanvasUpgrade(...) – PNG-Ausgabe nachtraeglich auf Canvas umstellen

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

globalThis.qpyodideCanvasPlots = {
  // Hauptschalter. Spaeter ggf. Dokument-Option bzw. Haken im Einstellungs-Panel;
  // fuer den Test in der Browser-Konsole umschaltbar:
  //   qpyodideCanvasPlots.enabled = false
  enabled: true,

  // Einrastender Cursor an Kurven und Punkten (Punkt-Anzeige mit Werten).
  // Je Zelle abschaltbar ueber "#| snap: false".
  snapCursor: true,

  // "idle" | "booting" | "ready" | "failed"
  status: "idle",

  // Messwerte des Experiments (fuer die Bewertung in der Konsole)
  bootSeconds: null,
  renderSeconds: [],

  // Die zweite Pyodide-Instanz bzw. das Promise darauf
  pyodide: null,
  bootPromise: null
};

// Python-Seite der zweiten Instanz: interaktives Backend aktivieren und einen
// Wiederhersteller fuer die pickle-Bytes aus dem Worker definieren.
const QPC_PY_SETUP = [
  "import base64, pickle",
  "import numpy as np",
  "import matplotlib",
  "",
  "# --- 1. Das HTML5-Canvas-Backend wieder einschalten ----------------------",
  "# In matplotlib-pyodide 0.2.3 (Pyodide 0.27.2) sind im Export-Block von",
  "# html5_canvas_backend.py die HTML5-Klassen auskommentiert:",
  "#     # FigureCanvas = FigureCanvasHTMLCanvas",
  "#     FigureCanvas = FigureCanvasAggWasm",
  "# Aktiv ist damit die Agg-Variante, die nur fertige Agg-Pixel ins Canvas",
  "# blittet - also genau dieselben Pixel wie unser Worker-PNG. Der eigentliche",
  "# Vektor-Renderer (RendererHTMLCanvas) wird nie benutzt. In v0.2.0 war er",
  "# aktiv; im Changelog steht zur Abschaltung nichts. Wir setzen ihn zurueck.",
  "import matplotlib_pyodide.html5_canvas_backend as _qpc_h5",
  "_qpc_h5._BackendHTMLCanvas.FigureCanvas  = _qpc_h5.FigureCanvasHTMLCanvas",
  "_qpc_h5._BackendHTMLCanvas.FigureManager = _qpc_h5.FigureManagerHTMLCanvas",
  "_qpc_h5.FigureCanvas  = _qpc_h5.FigureCanvasHTMLCanvas",
  "_qpc_h5.FigureManager = _qpc_h5.FigureManagerHTMLCanvas",
  "# Seit matplotlib 3.6 entscheidet canvas.manager_class, welcher Manager",
  "# entsteht; _Backend.FigureManager wird nicht mehr benutzt. matplotlib-pyodide",
  "# setzt manager_class nirgends - deshalb entsteht sonst nur ein nackter",
  "# FigureManagerBase, der keine Werkzeugleiste anlegt, canvas.toolbar bleibt",
  "# None und show() ueberspringt die Leiste stillschweigend. Daran haengt auch",
  "# die Koordinaten-Anzeige: NavigationToolbar2.__init__ setzt canvas.toolbar",
  "# und verbindet mouse_move, das die x/y-Werte in die Leiste schreibt.",
  "_qpc_h5.FigureCanvasHTMLCanvas.manager_class = _qpc_h5.FigureManagerHTMLCanvas",
  "matplotlib.use('module://matplotlib_pyodide.html5_canvas_backend', force=True)",
  "from matplotlib import pyplot as plt",
  "import matplotlib._pylab_helpers as _qpc_helpers",
  "",
  "# --- 2. Maus- und Tastatur-Ereignisse wieder anschliessen ----------------",
  "# In browser_backend.py sind die add_event_listener-Zeilen fuer das",
  "# rubberband-Canvas auskommentiert. Die vorhandenen Handler dort rufen",
  "# canvas.motion_notify_event() / button_press_event() auf - Methoden, die",
  "# matplotlib in 3.8 entfernt hat (Pyodide 0.27.2 liefert 3.8.4). Das ist",
  "# vermutlich der Grund fuers Auskommentieren. Deshalb hier eigene Handler",
  "# auf der aktuellen Event-API: Event(...)._process().",
  "from matplotlib.backend_bases import KeyEvent, MouseEvent",
  "from pyodide.ffi import create_proxy",
  "",
  "# Mauskoordinaten selbst umrechnen. Das Original nimmt event.offsetX gegen",
  "# die logische Figurengroesse und ignoriert devicePixelRatio sowie jede",
  "# CSS-Skalierung des Canvas - die angezeigten x/y-Werte waeren dann bei",
  "# Windows-Skalierung ungleich 100 % oder bei max-width-Verkleinerung falsch.",
  "# Ueber getBoundingClientRect stimmt es in jedem Fall.",
  "def _qpc_convert_mouse_event(self, event):",
  "    width, height = self.get_width_height()",
  "    rect = self.get_element('rubberband').getBoundingClientRect()",
  "    sx = width / rect.width if rect.width else 1.0",
  "    sy = height / rect.height if rect.height else 1.0",
  "    x = (event.clientX - rect.left) * sx",
  "    y = height - (event.clientY - rect.top) * sy",
  "    button = event.button + 1",
  "    if button == 3:",
  "        event.preventDefault()",
  "        event.stopPropagation()",
  "    if button == 2:",
  "        button = 3",
  "    return x, y, button",
  "",
  "_qpc_h5.FigureCanvasHTMLCanvas._convert_mouse_event = _qpc_convert_mouse_event",
  "",
  "# Proxies und Figuren festhalten. Bei den Proxies zwingend: Pyodide gibt sie",
  "# sonst frei und der Listener ruft ins Leere. Bei den Figuren, weil die",
  "# DOM-Ids des Backends hex(id(canvas)) sind und CPython die id() eines",
  "# freigegebenen Objekts wiederverwendet - eine neue Figur koennte sonst die",
  "# Id einer aelteren, noch sichtbaren erwischen und in deren Canvas zeichnen.",
  "_qpc_keep = []",
  "_qpc_proxies = []",
  "",
  "def _qpc_wire_events(canvas):",
  "    # Das rubberband-Canvas liegt oben auf und bekommt die Ereignisse.",
  "    rb = canvas.get_element('rubberband')",
  "    if rb is None:",
  "        return",
  "",
  "    def on_move(event):",
  "        x, y, button = canvas._convert_mouse_event(event)",
  "        MouseEvent('motion_notify_event', canvas, x, y, guiEvent=event)._process()",
  "",
  "    def on_down(event):",
  "        x, y, button = canvas._convert_mouse_event(event)",
  "        MouseEvent('button_press_event', canvas, x, y, button, guiEvent=event)._process()",
  "",
  "    def on_up(event):",
  "        x, y, button = canvas._convert_mouse_event(event)",
  "        MouseEvent('button_release_event', canvas, x, y, button, guiEvent=event)._process()",
  "",
  "    def on_enter(event):",
  "        rb.focus()   # Tastatur-Fokus, damit Kuerzel wie 'p' und 'o' wirken",
  "",
  "    def on_leave(event):",
  "        rb.blur()",
  "",
  "    def on_keydown(event):",
  "        KeyEvent('key_press_event', canvas,",
  "                 canvas._convert_key_event(event), guiEvent=event)._process()",
  "",
  "    def on_keyup(event):",
  "        KeyEvent('key_release_event', canvas,",
  "                 canvas._convert_key_event(event), guiEvent=event)._process()",
  "",
  "    for name, handler in (('mousemove', on_move), ('mousedown', on_down),",
  "                          ('mouseup', on_up), ('mouseenter', on_enter),",
  "                          ('mouseleave', on_leave), ('keydown', on_keydown),",
  "                          ('keyup', on_keyup)):",
  "        proxy = create_proxy(handler)",
  "        _qpc_proxies.append(proxy)",
  "        rb.addEventListener(name, proxy)",
  "",
  "# --- 3. Einrastender Cursor ----------------------------------------------",
  "# matplotlib bringt das nicht mit: matplotlib.widgets.Cursor zeichnet nur ein",
  "# freilaufendes Fadenkreuz und rastet nicht ein. Deshalb eine eigene kleine",
  "# Klasse. Der naechste Punkt wird in Pixel-Abstand gesucht, nicht in",
  "# Datenwerten - sonst verzerren unterschiedlich skalierte Achsen das Ergebnis.",
  "",
  "_QPC_SNAP_RADIUS = 45      # Pixel; weiter weg wird nichts angezeigt",
  "",
  "class _QpcSnapCursor:",
  "    def __init__(self, ax, sources, bars):",
  "        self.ax = ax",
  "        self.sources = sources",
  "        self.bars = bars       # Liste von (patch, orientation, value, label)",
  "        self._last = None",
  "        # Grenzen sichern: axvline/axhline nehmen an der Autoskalierung teil",
  "        # und wuerden die Achsen sonst verschieben.",
  "        xlim, ylim = ax.get_xlim(), ax.get_ylim()",
  "        self.vline = ax.axvline(0, color='0.45', lw=0.8, ls=':', visible=False)",
  "        self.hline = ax.axhline(0, color='0.45', lw=0.8, ls=':', visible=False)",
  "        self.marker, = ax.plot([], [], 'o', ms=8, mfc='none', mec='#cc0000',",
  "                               mew=1.6, visible=False)",
  "        self.label = ax.annotate(",
  "            '', xy=(0, 0), xytext=(9, 9), textcoords='offset points',",
  "            fontsize=9, visible=False, zorder=10,",
  "            bbox=dict(boxstyle='round,pad=0.35', fc='#ffffe0', ec='0.6', alpha=0.95))",
  "        ax.set_xlim(xlim)",
  "        ax.set_ylim(ylim)",
  "",
  "    def on_move(self, event):",
  "        if event.inaxes is not self.ax:",
  "            self._hide()",
  "            return",
  "        if self._hit_bar(event):",
  "            return",
  "        best = None",
  "        for artist, xy, trans in self.sources:",
  "            pix = trans.transform(xy)",
  "            dist = np.hypot(pix[:, 0] - event.x, pix[:, 1] - event.y)",
  "            i = int(np.argmin(dist))",
  "            if best is None or dist[i] < best[0]:",
  "                best = (float(dist[i]), artist, xy[i])",
  "        if best is None or best[0] > _QPC_SNAP_RADIUS:",
  "            self._hide()",
  "            return",
  "        x, y = float(best[2][0]), float(best[2][1])",
  "        key = (id(best[1]), x, y)",
  "        if key == self._last:",
  "            return          # gleicher Punkt -> kein Neuzeichnen (das ist teuer)",
  "        self._last = key",
  "        self.vline.set_xdata([x, x])",
  "        self.hline.set_ydata([y, y])",
  "        self.marker.set_data([x], [y])",
  "        name = best[1].get_label()",
  "        head = (name + '\\n') if name and not name.startswith('_') else ''",
  "        self.label.set_text(head + 'x = %.6g\\ny = %.6g' % (x, y))",
  "        self.label.xy = (x, y)",
  "        for artist in (self.vline, self.hline, self.marker, self.label):",
  "            artist.set_visible(True)",
  "        self.ax.figure.canvas.draw_idle()",
  "",
  "    def _hit_bar(self, event):",
  "        # Flaechentreffer statt Punkt-Distanz: die Bbox kommt live aus",
  "        # get_window_extent(), das bereits die aktuelle (ggf. gezoomte)",
  "        # Transformation nutzt - anders als bei Linien/Punkten cachen wir",
  "        # hier also nicht die Pixel-Position, sondern nur das Patch-Objekt.",
  "        for patch, orientation, value, label in self.bars:",
  "            bbox = patch.get_window_extent()",
  "            pad = 2  # etwas Toleranz am Rand",
  "            if not (bbox.x0 - pad <= event.x <= bbox.x1 + pad",
  "                    and bbox.y0 - pad <= event.y <= bbox.y1 + pad):",
  "                continue",
  "            if orientation == \"horizontal\":",
  "                edge_x = bbox.x1 if value >= 0 else bbox.x0",
  "                point_px = (edge_x, (bbox.y0 + bbox.y1) / 2)",
  "            else:",
  "                edge_y = bbox.y1 if value >= 0 else bbox.y0",
  "                point_px = ((bbox.x0 + bbox.x1) / 2, edge_y)",
  "            inv = self.ax.transData.inverted()",
  "            x, y = inv.transform(point_px)",
  "            key = (id(patch), \"bar\")",
  "            if key != self._last:",
  "                self._last = key",
  "                self.vline.set_xdata([x, x])",
  "                self.hline.set_ydata([y, y])",
  "                self.marker.set_data([x], [y])",
  "                head = (label + \"\\n\") if label and not label.startswith(\"_\") else \"\"",
  `                self.label.set_text(head + "${QP_L.canvasBarValueLabel} = %.6g" % value)`,
  "                self.label.xy = (x, y)",
  "                for artist in (self.vline, self.hline, self.marker, self.label):",
  "                    artist.set_visible(True)",
  "                self.ax.figure.canvas.draw_idle()",
  "            return True",
  "        return False",
  "",
  "    def _hide(self):",
  "        if self._last is None:",
  "            return",
  "        self._last = None",
  "        for artist in (self.vline, self.hline, self.marker, self.label):",
  "            artist.set_visible(False)",
  "        self.ax.figure.canvas.draw_idle()",
  "",
  "",
  "def _qpc_snap_sources(ax):",
  "    # Datenquellen einsammeln, BEVOR der Cursor seine eigenen Hilfslinien",
  "    # anlegt - sonst rastet er auf sich selbst ein.",
  "    sources = []",
  "    for line in ax.get_lines():",
  "        xdata = np.asarray(line.get_xdata(), dtype=float)",
  "        ydata = np.asarray(line.get_ydata(), dtype=float)",
  "        if xdata.size and xdata.size == ydata.size:",
  "            sources.append((line, np.column_stack([xdata, ydata]),",
  "                            line.get_transform()))",
  "    for coll in ax.collections:",
  "        if not hasattr(coll, 'get_offsets'):",
  "            continue",
  "        offsets = np.asarray(coll.get_offsets(), dtype=float)",
  "        if offsets.ndim == 2 and offsets.shape[0]:",
  "            sources.append((coll, offsets, coll.get_offset_transform()))",
  "    return sources",
  "",
  "",
  "def _qpc_bar_sources(ax):",
  "    # Balkendiagramme UND Histogramme: Axes.bar()/Axes.hist() haengen ihre",
  "    # Rechtecke als BarContainer an ax.containers. datavalues traegt den",
  "    # eigentlichen Wert (bei gestapelten Balken != get_height()); get_window_extent()",
  "    # kommt in fig.get_axes()-Reihenfolge bereits in Pixelkoordinaten.",
  "    import matplotlib.container as mcontainer",
  "    bars = []",
  "    for container in getattr(ax, 'containers', []):",
  "        if not isinstance(container, mcontainer.BarContainer):",
  "            continue",
  "        orientation = container.orientation or 'vertical'",
  "        values = container.datavalues",
  "        label = container.get_label()",
  "        for i, patch in enumerate(container.patches):",
  "            value = float(values[i]) if values is not None else (",
  "                patch.get_height() if orientation == 'vertical' else patch.get_width())",
  "            bars.append((patch, orientation, value, label))",
  "    return bars",
  "",
  "",
  "def _qpc_attach_snap(fig):",
  "    for ax in fig.get_axes():",
  "        sources = _qpc_snap_sources(ax)",
  "        bars = _qpc_bar_sources(ax)",
  "        if not sources and not bars:",
  "            continue      # z. B. reine Bild-Achsen (imshow) oder Colorbars",
  "        cursor = _QpcSnapCursor(ax, sources, bars)",
  "        fig.canvas.mpl_connect('motion_notify_event', cursor.on_move)",
  "        _qpc_keep.append(cursor)",
  "",
  "# --- 4. Figur aus dem Worker wiederherstellen und zeigen -----------------",
  "",
  "def _qpc_show(payload, snap=True):",
  "    # Die Figur-Registry leeren, damit plt.show() nur die neue Figur zeigt.",
  "    # Absichtlich .clear() statt plt.close('all'): close() wuerde den Manager",
  "    # zerstoeren und damit die bereits gezeichneten Canvas aus dem DOM",
  "    # entfernen. Hier soll nur die Registry vergessen werden.",
  "    _qpc_helpers.Gcf.figs.clear()",
  "    fig = pickle.loads(base64.b64decode(payload))",
  "    if not _qpc_helpers.Gcf.figs:",
  "        # Figur war im Worker nicht bei pyplot registriert (z. B. direkt",
  "        # ueber Figure() erzeugt) -> Manager selbst anlegen.",
  "        mgr = plt._backend_mod.new_figure_manager_given_figure(len(_qpc_keep) + 1, fig)",
  "        _qpc_helpers.Gcf._set_new_active_manager(mgr)",
  "    # Das Worker-PNG entsteht mit bbox_inches='tight' - dort waechst die",
  "    # Bildflaeche um die Beschriftung herum. Das Canvas rendert dagegen exakt",
  "    # die Figurenflaeche und schneidet alles darueber hinaus ab (sichtbar z. B.",
  "    # an einer halb abgeschnittenen Achsenbeschriftung bei df.plot()). Das",
  "    # tight-Layout ordnet stattdessen innerhalb der Flaeche um.",
  "    # tight_layout() rechnet einmal und setzt die Layout-Engine danach",
  "    # selbst auf 'none' zurueck. Wichtig: set_layout_engine('tight') wuerde",
  "    # bei JEDEM Neuzeichnen neu umlayouten - und der einrastende Cursor",
  "    # zeichnet viel neu.",
  "    try:",
  "        fig.tight_layout()",
  "    except Exception as exc:",
  "        print('qpyodide: tight_layout uebersprungen:', exc)",
  "    if snap:",
  "        _qpc_attach_snap(fig)",
  "    plt.show()",
  "    _qpc_keep.append(fig)",
  "    _qpc_wire_events(fig.canvas)",
  "    return True",
  "",
  "def _qpc_redraw(count):",
  "    # Nach dem Einblenden nochmal zeichnen. Beim allerersten Plot sind die",
  "    # Web-Fonts noch nicht geladen; deren Callback zeichnet zwar selbst nach,",
  "    # dieser Aufruf macht das Ergebnis aber unabhaengig von diesem Rennen.",
  "    for item in _qpc_keep[-count:]:",
  "        if hasattr(item, 'canvas'):",
  "            item.canvas.draw()",
  "    return True"
].join("\n");

// ---------------------------------------------------------------------------
// Zweite Pyodide-Instanz (Haupt-Thread) laden
// ---------------------------------------------------------------------------

/**
 * Laedt die Canvas-Instanz beim ersten Aufruf und liefert danach immer
 * dieselbe. Der Download kommt fast vollstaendig aus dem HTTP-Cache, weil der
 * Worker dieselben Dateien schon geholt hat; die Zeit geht fuer WebAssembly-
 * Instanziierung und das Auspacken von matplotlib drauf.
 */
function qpyodideCanvasEngine() {
  const state = globalThis.qpyodideCanvasPlots;
  if (state.bootPromise) return state.bootPromise;

  state.status = "booting";
  state.bootPromise = (async () => {
    const started = performance.now();
    const indexURL = qpyodideCustomizedPyodideOptions.indexURL;
    const mod = await import(indexURL + "pyodide.mjs");

    const py = await mod.loadPyodide({
      indexURL: indexURL,
      env: qpyodideCustomizedPyodideOptions.env,
      // Diese Instanz zeichnet nur; Ausgaben gehoeren nicht ins Zell-Terminal.
      stdout: (text) => console.debug("qpyodide/canvas:", text),
      stderr: (text) => console.warn("qpyodide/canvas:", text)
    });

    await py.loadPackage("matplotlib");
    await py.runPythonAsync(QPC_PY_SETUP);

    state.pyodide = py;
    state.status = "ready";
    state.bootSeconds = (performance.now() - started) / 1000;
    console.log(
      "qpyodide: zweite Pyodide-Instanz (Canvas-Plots) bereit nach " +
      state.bootSeconds.toFixed(1) + "s" + qpyodideCanvasMemoryNote()
    );
    return py;
  })();

  state.bootPromise.catch(() => {
    state.status = "failed";
  });

  return state.bootPromise;
}

/** Speicherverbrauch, falls der Browser ihn verraet (nur Chromium). */
function qpyodideCanvasMemoryNote() {
  const mem = performance.memory;
  if (!mem) return "";
  const mb = (bytes) => (bytes / 1048576).toFixed(0) + " MB";
  return " (JS-Heap " + mb(mem.usedJSHeapSize) + " von " + mb(mem.jsHeapSizeLimit) + ")";
}

// ---------------------------------------------------------------------------
// Zeichnen: pickle -> Canvas
// ---------------------------------------------------------------------------

// Die Canvas-Instanz kennt nur ein globales Ziel (document.pyodideMplTarget).
// Deshalb duerfen nie zwei Zellen gleichzeitig zeichnen.
let qpyodideCanvasQueue = Promise.resolve();

function qpyodideCanvasSerialize(task) {
  const run = qpyodideCanvasQueue.then(task, task);
  qpyodideCanvasQueue = run.catch(() => {});
  return run;
}

/**
 * Text der Hinweiszeile setzen. Waehrend gewartet wird mit Spinner davor, damit
 * unuebersehbar ist, dass gerade etwas laedt; Fehlermeldungen ohne.
 */
function qpyodideCanvasHintText(hint, text, spinning) {
  hint.textContent = "";
  if (spinning) {
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-circle-notch fa-spin";
    hint.appendChild(icon);
    hint.appendChild(document.createTextNode(" "));
  }
  hint.appendChild(document.createTextNode(text));
}

/**
 * Soll der einrastende Cursor an die Figur? Abschaltbar global ueber
 * qpyodideCanvasPlots.snapCursor oder je Zelle ueber die Option "#| snap: false".
 */
function qpyodideCanvasSnapWanted(options) {
  if (globalThis.qpyodideCanvasPlots.snapCursor === false) return false;
  return (options || {})["snap"] !== "false";
}

/** Soll fuer diese Zelle ueberhaupt auf Canvas umgestellt werden? */
globalThis.qpyodideCanvasWanted = function (options) {
  const state = globalThis.qpyodideCanvasPlots;
  if (!state || !state.enabled || state.status === "failed") return false;
  return (options || {})["canvas"] !== "false";
};

/**
 * Ersetzt die schon sichtbare PNG-Ausgabe eines Laufs durch interaktive
 * Canvas-Figuren. Laeuft absichtlich ohne await im Aufrufer: die Zelle ist
 * fertig, das Nachladen darf im Hintergrund passieren.
 *
 * @param {Element}  targetDiv Ausgabe-Container der Zelle (outputGraphDiv)
 * @param {string[]} pickles   Base64-pickles der Figuren, in Reihenfolge
 * @param {Object}   options   Zell-Optionen (fuer fig-cap)
 */
globalThis.qpyodideCanvasUpgrade = async function (targetDiv, pickles, options) {
  // Nur die eigene PNG-Ausgabe treffen: in derselben Zelle kann darueber ein
  // Animations-Player stehen (.qpyodide-html-output), dessen Markup nicht
  // angefasst werden darf. Der PNG-<figure> ist immer direktes Kind.
  const pngFigure = targetDiv.querySelector(":scope > figure");

  const hint = document.createElement("div");
  hint.className = "qpyodide-canvas-hint";
  qpyodideCanvasHintText(
    hint,
    (globalThis.qpyodideCanvasPlots.status === "ready")
      ? QP_L.canvasRendering
      : QP_L.canvasPreparing,
    true
  );
  targetDiv.appendChild(hint);

  let py;
  try {
    py = await qpyodideCanvasEngine();
  } catch (err) {
    qpyodideCanvasHintText(hint, QP_L.canvasEngineFailed, false);
    console.error("qpyodide: zweite Pyodide-Instanz nicht ladbar", err);
    return;
  }

  // Zelle wurde waehrend des Ladens erneut ausgefuehrt -> Ergebnis verwerfen
  if (!hint.isConnected) return;

  // WICHTIG: Das Zielelement muss beim Zeichnen im Dokument haengen. Das
  // Canvas-Backend sucht sein eigenes Canvas ueber document.getElementById
  // (FigureCanvasWasm.get_element); in einem losgeloesten Element findet es
  // nichts und FigureCanvasHTMLCanvas.draw() bricht ohne Fehler ab -> leeres,
  // weisses Canvas. Verborgen (display:none) ist dagegen unproblematisch:
  // getElementById braucht Dokument-Zugehoerigkeit, kein Layout.
  const figure = document.createElement("figure");
  figure.className = "qpyodide-canvas-figure";
  figure.hidden = true;
  targetDiv.appendChild(figure);

  const started = performance.now();
  try {
    await qpyodideCanvasSerialize(async () => {
      document.pyodideMplTarget = figure;
      const snap = qpyodideCanvasSnapWanted(options) ? "True" : "False";
      for (const payload of pickles) {
        py.globals.set("_qpc_payload", payload);
        await py.runPythonAsync("_qpc_show(_qpc_payload, " + snap + ")");
      }
    });
  } catch (err) {
    // Wiederherstellung gescheitert (z. B. fehlendes Modul im pickle) ->
    // das PNG bleibt die Ausgabe.
    figure.remove();
    if (hint.isConnected) qpyodideCanvasHintText(hint, QP_L.canvasRenderFailed, false);
    console.warn("qpyodide: Figur nicht als Canvas darstellbar", err);
    return;
  }

  // Zelle lief waehrend des Zeichnens erneut -> Ergebnis verwerfen
  if (!hint.isConnected) return;

  if (options && options["fig-cap"]) {
    const figcaption = document.createElement("figcaption");
    figcaption.innerText = options["fig-cap"];
    figure.appendChild(figcaption);
  }

  // Einblenden und PNG entfernen ohne Bildaufbau dazwischen (gleicher Task).
  figure.hidden = false;
  if (pngFigure) pngFigure.remove();
  hint.remove();
  targetDiv.classList.add("has-content");

  // Jetzt sichtbar -> Nachzeichnen, damit Schrift und Layout sicher stehen.
  try {
    await qpyodideCanvasSerialize(() => py.runPythonAsync("_qpc_redraw(" + pickles.length + ")"));
  } catch (err) {
    console.warn("qpyodide: Nachzeichnen fehlgeschlagen", err);
  }

  const seconds = (performance.now() - started) / 1000;
  globalThis.qpyodideCanvasPlots.renderSeconds.push(seconds);
  console.log("qpyodide: Canvas-Figur(en) gezeichnet in " + seconds.toFixed(2) + "s");
};
