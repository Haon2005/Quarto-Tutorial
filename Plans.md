Ground Structure:
3 Profiles [beg(inner), int(ermidiate), exp(ert)]
(Important! no Link difference between beginner intermidiate and expert, rather questsions:
- Did you ever see a Page created with Quarto before?
- Did you ever create your own Quarto Page?
- Do you want to become better at using Quarto?)


Beginner structure:
An example Page of things Quarto could do
- So using Code, showing calculated Graphics
- Showing jsxgraph
- Showing highlited Texts
- Showing Callouts with special Icons

Intermediate structure:
- Getting started
- Creating a Website with Quarto
- Creating an Exercise Sheet with Quarto
- Creating a Book with Quarto

Expert structure:
- What does Quarto do
- Set up
    - Programms needed
    - Formats possible
    - Files needed
        - what does a .yml do
        - what does a .qmd do
        - what does a .css do
    - Extensions
        - installing Extensions
        - using Extensions
- Useful Stuff
    - Useful Extensions
        - pyodide
        - quizdown
        - jsxgraph
        - (Own Extension)
    - Useful Configurations
        - yml (Mehrere Formate, Globale Variablen)
        - qmd (Callouts, Visible when)

Plan mit Claude
===============

## Example Site — Multi-Page Structure

Instead of one long page, the Beginner Example is a small **multi-page mini-site**.
This lets us also demonstrate: sidebar navigation, cross-page links, and integrated citations.

### File Structure

```
beg/
├── index_beg.qmd         ← Welcome & Overview (entry point)
├── text_layout.qmd       ← Text, Callouts & Layout
├── code.qmd              ← Code: static / executable / editable
├── visuals.qmd           ← JSXGraph + Mermaid diagrams
├── quiz.qmd              ← Quizdown interactive quiz
└── references.qmd        ← Bibliography & how to cite in Quarto
references.bib            ← BibTeX file used across all pages
```

### Page Breakdown

| Page | File | Features Showcased |
|------|------|--------------------|
| 1 — Welcome | `index_beg.qmd` | Callouts (tip/note/warning), overview text, links to all sub-pages |
| 2 — Text & Layout | `text_layout.qmd` | Callouts with custom icons, column layout, tabs, highlighted code |
| 3 — Code | `code.qmd` | Static output-only code, `{pyodide}` executable, `py-exercise` editable |
| 4 — Visuals | `visuals.qmd` | `jsxgraph` interactive plot, `mermaid` diagram (flowchart or mindmap) |
| 5 — Quiz | `quiz.qmd` | `quizdown` multiple-choice quiz |
| 6 — References | `references.qmd` | Integrated citations (`[@key]`), rendered bibliography from `.bib` file |

### Cross-Page Features to Demo

- **Navigation**: sidebar lists all pages; prev/next buttons at page bottom
- **Cross-links**: pages reference each other (e.g. code page links to visuals page)
- **Citations**: sprinkled on relevant pages (e.g. Python on code page, JSXGraph on visuals page), all collected on references page

### Cohesive Theme

All pages are loosely tied together by the topic **"Exploring Mathematical Functions"**:
- Code page: compute and print values of a function
- JSXGraph: plot that function interactively
- Mermaid: flowchart of how the computation works
- Quiz: test understanding of the concept
- References: cite the relevant mathematical or software sources

## Intermidiate Structure
