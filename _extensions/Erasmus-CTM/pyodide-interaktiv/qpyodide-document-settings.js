// qpyodide-document-settings.js – Dokumentweite Einstellungen (Template)
//
// Diese Datei ist ein Template: Die {{PLATZHALTER}} werden vom Lua-Filter
// (qpyodide.lua, Funktion initializationPyodide) beim Rendern ersetzt.
// Sie wird als erstes Modul in den <head> injiziert, damit alle weiteren
// Module auf die globalen Einstellungen zugreifen können.

// Document level settings ----

// Determine if we need to install python packages
globalThis.qpyodideInstallPythonPackagesList = [{{INSTALLPYTHONPACKAGESLIST}}];

// Check to see if we have an empty array, if we do set to skip the installation.
globalThis.qpyodideSetupPythonPackages = !(qpyodideInstallPythonPackagesList.indexOf("") !== -1);

// Display a startup message?
globalThis.qpyodideShowStartupMessage = {{SHOWSTARTUPMESSAGE}};

// Describe the Pyodide settings that should be used.
// Nur Daten (keine Funktionen) – die Konfiguration wird per postMessage an
// den Pyodide-Web-Worker übergeben; stdout/stderr sammelt der Worker selbst.
globalThis.qpyodideCustomizedPyodideOptions = {
  "indexURL": "{{INDEXURL}}",
  "env": {
    "HOME": "{{HOMEDIR}}",
  }
}

// UI language for this render pass ----
//
// Set by the Lua filter from `pyodide: lang:` or Quartos own `lang:`.
// qpyodide-locales.js picks the matching translation table from this value.
globalThis.qpyodideLang = "{{LANG}}";

// Store cell data
globalThis.qpyodideCellDetails = {{QPYODIDECELLDETAILS}};

// AI feedback feature settings ----
//
// enabled : Feedback-Button pro interaktiver Zelle anzeigen?
// storage : Vorgabe, wo die Zugangsdaten gespeichert werden
//           ("local" = localStorage, dauerhaft; "session" = sessionStorage, pro Tab).
//           Kann vom Nutzer im Einstellungs-Panel geändert werden.
// hints   : Progressive Hinweise – das Hinweis-Level steigt mit jedem Klick
//           auf den Feedback-Button derselben Zelle.
globalThis.qpyodideFeedbackOptions = {
  enabled: {{FEEDBACKENABLED}},
  storage: "{{FEEDBACKSTORAGE}}",
  hints: {{FEEDBACKHINTS}}
};
