// coi-serviceworker.js – Cross-Origin-Isolation via Service Worker
//
// Aktiviert SharedArrayBuffer auf HTTPS-Hosts ohne COOP/COEP-Server-Header
// (z.B. GitHub Pages). Der Service Worker fängt alle Requests ab und hängt
// die nötigen Header an die Responses.
//
// Basiert auf: https://github.com/gzuidhof/coi-serviceworker (MIT-Lizenz)
//
// Ablauf:
//   1. Lua-Filter kopiert diese Datei beim Rendern ins Projekt-Root.
//   2. Der Filter injiziert <script src="/coi-serviceworker.js"> ins HTML.
//   3. Auf der ersten Seite registriert das Skript den Service Worker und
//      wartet auf navigator.serviceWorker.ready (SW wirklich aktiv, nicht
//      nur registriert).
//   4. qpyodide-document-status.js lädt die Seite automatisch einmal neu,
//      sobald der SW bereit ist (Event "coi-sw-ready") – außer der User
//      tippt/klickt bereits irgendwo, dann wird der Reload für diese
//      Sitzung übersprungen → SW fängt die Navigation ab →
//      crossOriginIsolated === true → input() verfügbar.
//
// Events an qpyodide-document-status.js:
//   "coi-sw-ready"   – SW registriert UND aktiv, löst den automatischen
//                      Reload aus
//   "coi-unavailable"– COI auf dieser Origin nicht erreichbar (kein SW-Support,
//                      Registration fehlgeschlagen, oder Reload hat nichts gebracht)
//
// Persistenz:
//   sessionStorage "qpyodide-coi-reload-pending" – gesetzt vor dem Check-Reload;
//     zusammen mit navigation.type "reload" erkennen wir, ob der Reload COI
//     gebracht hat oder nicht.
//   localStorage "qpyodide-coi-unavailable-<origin>" – dauerhaftes Urteil, sobald
//     ein Reload nachweislich kein COI gebracht hat. Verhindert erneute
//     "prüfen"-Schleife bei späteren Besuchen. Wird gelöscht, sobald
//     crossOriginIsolated === true (z. B. nach Serverkonfigurationsänderung).

if (typeof window === "undefined") {
  // ── Service-Worker-Kontext ─────────────────────────────────────────────────
  // COOP/COEP-Header an jede Response anhängen

  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

  self.addEventListener("fetch", event => {
    const req = event.request;
    // Opaque Requests (z. B. no-cors cross-origin) überspringen
    if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;

    event.respondWith(
      fetch(req).then(resp => {
        if (resp.status === 0) return resp;
        const headers = new Headers(resp.headers);
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        headers.set("Cross-Origin-Embedder-Policy", "credentialless");
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers,
        });
      })
    );
  });

} else {
  // ── Seiten-Kontext ─────────────────────────────────────────────────────────

  (function () {
    var RELOAD_FLAG = "qpyodide-coi-reload-pending";
    var LS_UNAVAIL  = "qpyodide-coi-unavailable-" + location.origin;

    function lsGet(k)    { try { return localStorage.getItem(k);      } catch (e) { return null; } }
    function lsSet(k, v) { try {   localStorage.setItem(k, v);        } catch (e) { /* blockiert */ } }
    function lsDel(k)    { try {   localStorage.removeItem(k);         } catch (e) { /* blockiert */ } }
    function ssGet(k)    { try { return sessionStorage.getItem(k);    } catch (e) { return null; } }
    function ssDel(k)    { try {   sessionStorage.removeItem(k);       } catch (e) { /* blockiert */ } }
    function log(msg)    { console.log("[qpyodide-coi] " + msg); }

    // Ergebnis zusätzlich zum Event synchron ablegen (globalThis.qpyodideCoiOutcome
    // = "ready" | "unavailable"). Grund: dieses Skript kann – z. B. wenn der SW aus
    // einem früheren Reload schon aktiv ist – schneller fertig sein, als
    // qpyodide-document-status.js seinen Event-Listener registriert hat. Ein
    // einmalig gefeuertes CustomEvent würde dann ungehört verpuffen. Wer den
    // Zustand später abfragt (statt nur auf das Event zu warten), bekommt ihn
    // trotzdem mit.
    function emit(kind) {
      globalThis.qpyodideCoiOutcome = kind;
      window.dispatchEvent(new CustomEvent(
        kind === "ready" ? "coi-sw-ready" : "coi-unavailable"));
    }

    // Bereits isoliert: input() funktioniert. Altes "geht nicht"-Urteil zurücknehmen.
    if (globalThis.crossOriginIsolated) {
      log("bereits crossOriginIsolated – nichts zu tun.");
      lsDel(LS_UNAVAIL);
      ssDel(RELOAD_FLAG);
      return;
    }

    // Service Worker nicht unterstützt (file://, sehr alter Browser).
    if (!("serviceWorker" in navigator)) {
      log("navigator.serviceWorker nicht verfügbar (file:// oder alter Browser).");
      emit("unavailable");
      return;
    }

    // Für diese Origin wurde COI bereits als dauerhaft nicht verfügbar eingestuft.
    if (lsGet(LS_UNAVAIL)) {
      log("laut localStorage (" + LS_UNAVAIL + ") bereits dauerhaft als nicht verfügbar markiert.");
      emit("unavailable");
      return;
    }

    // War dieser Seitenaufruf der vom User ausgelöste Check-Reload?
    // Wenn ja und COI fehlt trotzdem → dauerhaft nicht verfügbar.
    var hadFlag = !!ssGet(RELOAD_FLAG);
    ssDel(RELOAD_FLAG);
    if (hadFlag) {
      var isReload = false;
      try { isReload = performance.getEntriesByType("navigation")[0].type === "reload"; } catch (e) { /* nicht verfügbar */ }
      log("Reload-Flag war gesetzt, navigation.type=" +
        (performance.getEntriesByType("navigation")[0] || {}).type + ", isReload=" + isReload);
      if (isReload) {
        log("Reload hat COI nicht gebracht – markiere dauerhaft nicht verfügbar.");
        lsSet(LS_UNAVAIL, "1");
        emit("unavailable");
        return;
      }
    }

    // SW registrieren und auf "ready" warten (= SW hat activate() inkl.
    // clients.claim() abgeschlossen). register() allein reicht NICHT: das
    // Promise löst schon auf, sobald die Registrierung angelegt ist – oft
    // Millisekunden bevor der SW wirklich aktiv ist. Ein sofortiger Reload
    // an dieser Stelle (siehe qpyodide-document-status.js) würde die
    // Navigation dann verpassen, crossOriginIsolated bliebe false, und der
    // Reload-Check oben (hadFlag + isReload) würde die Seite fälschlich
    // dauerhaft als "nicht verfügbar" markieren.
    var swUrl = document.currentScript ? document.currentScript.src : "/coi-serviceworker.js";
    log("registriere Service Worker: " + swUrl);
    navigator.serviceWorker.register(swUrl).then(function (reg) {
      log("register() aufgelöst (scope=" + reg.scope + "), warte auf serviceWorker.ready …");
      return navigator.serviceWorker.ready;
    }).then(function () {
      log("serviceWorker.ready – feuere coi-sw-ready.");
      emit("ready");
    }).catch(function (err) {
      log("register()/ready fehlgeschlagen: " + err);
      lsSet(LS_UNAVAIL, "1");
      emit("unavailable");
    });
  }());
}
