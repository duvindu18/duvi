import { SECTION_NAMES, type Section } from '../state/AppState'

const NOTES: Partial<Record<Section, { when: string; what: string }>> = {
  chat: { when: 'milestone 3', what: 'Ask questions of gpt-oss on your own PC, with replies streaming in as they are written.' },
  scripts: { when: 'milestone 4', what: 'Generate, explain and fix Dynamo, pyRevit, Grasshopper, AutoLISP, Blender and Office scripts.' },
  visual: { when: 'milestone 5', what: 'Turn prompts, sketches and massing screenshots into renders with ComfyUI.' },
  skills: { when: 'milestone 6', what: 'Add instruction packs that make the local model better at specific tasks.' },
  documents: { when: 'phase 2 (milestone 8)', what: 'Ask questions about UDA regulations and client briefs, with page references.' }
}

export function Later({ section }: { section: Section }) {
  const n = NOTES[section]
  return (
    <>
      <header className="page-head">
        <h1 className="page-title">{SECTION_NAMES[section]}</h1>
      </header>
      <div className="later" data-testid="later">
        <p>{n?.what}</p>
        <p>This part of the app arrives in {n?.when}.</p>
      </div>
    </>
  )
}
