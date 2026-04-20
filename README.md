# What Quarto Can Do — A Multi-Level Tutorial

A Quarto-based tutorial website aimed at lecturers and academic staff who want to learn what Quarto is and how to use it.
The tutorial is split into three independent levels — visitors self-select the one that fits them best.

---

## The three levels

| Level | Who it is for | Content |
|---|---|---|
| **Beginner** | Never seen a Quarto page before | An interactive showcase: live Python code, interactive graphs, quizzes, citations — to show what Quarto can produce |
| **Intermediate** | Wants to create their own Quarto documents | Step-by-step guides for building a website, an exercise sheet, and a book — with screenshots |
| **Expert** | Already uses Quarto, wants to go deeper | Deep-dives into `.yml`, `.qmd`, `.css`, extensions, and advanced configuration |

---

## Project structure

```
├── Qmd Files/
│   ├── Example Page/        ← Beginner showcase pages
│   ├── Getting Started/     ← Intermediate tutorial pages
│   └── Tipps and Tricks/    ← Expert pages (in progress)
├── Img Files/
│   └── Getting Started/     ← Screenshots used in the intermediate tutorial
├── docs/
│   ├── beg/                 ← Rendered beginner site
│   ├── int/                 ← Rendered intermediate site
│   └── exp/                 ← Rendered expert site
├── _extensions/             ← Quarto extensions (pyodide, py-exercise, jsxgraph, quizdown)
├── _quarto.yml              ← Root config: profile group definition
├── _quarto-beg.yml          ← Beginner profile config
├── _quarto-int.yml          ← Intermediate profile config
├── _quarto-exp.yml          ← Expert profile config
└── preview.py               ← Local preview script
```

---

## Extensions used

| Extension | Purpose |
|---|---|
| [`coatless-quarto/pyodide`](https://github.com/coatless-quarto/pyodide) | Run Python code live in the browser |
| [`Erasmus-CTM/py-exercise`](https://github.com/Erasmus-CTM/py-exercise) | Editable Python exercises with hidden tests |
| [`jsxgraph/jsxgraph`](https://github.com/jsxgraph/jsxgraph) | Interactive mathematical graphs |
| [`parmsam/quizdown`](https://github.com/parmsam/quizdown) | Interactive multiple-choice quizzes |

---

## Local preview

Requires [Quarto](https://quarto.org/docs/get-started/) and Python 3.

```bash
python preview.py
```

This renders all three profiles and serves them locally at `http://localhost:8000/beg/index.html`.

To skip re-rendering (serve existing output only):

```bash
python preview.py --no-render
```

---

## Status

- [x] Beginner — complete
- [x] Intermediate — complete
- [ ] Expert — in progress
