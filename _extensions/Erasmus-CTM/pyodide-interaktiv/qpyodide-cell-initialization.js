// qpyodide-cell-initialization.js – Zellen aufbauen und Startphase anstoßen
//
// Baut für jeden vom Lua-Filter eingesammelten Codeblock die passende Zelle
// auf (siehe qpyodide-cell-classes.js) und führt nach dem Pyodide-Start die
// setup-/output-/autorun-Zellen aus.

qpyodideCellDetails.forEach((entry) => {
  qpyodideCellContainer.addCell(qpyodideCreateCell(entry));
});

qpyodideReady
  .then(() => qpyodideCellContainer.runStartupCells())
  .catch((err) => console.error("qpyodide: Startphase fehlgeschlagen", err));
