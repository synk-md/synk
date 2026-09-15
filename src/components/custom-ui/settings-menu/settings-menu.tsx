import * as React from "react"
import { createPortal } from "react-dom"
import { RiSettings3Line, RiCloseLine, RiSearchLine, RiUserLine, RiPaletteLine, RiLayoutLine, RiEditLine } from "@remixicon/react"
import { Button } from "@/components/tiptap-ui-primitive/button"
import { useTheme, useColorTheme, colorThemes, type Theme } from "@/components/custom-ui/ui-store/theme-store"
import { useToolbarVisible, setToolbarVisible, useInlineTitleVisible, setInlineTitleVisible } from "@/components/custom-ui/ui-store/ui-store"
import { useEditorSettings, setEditorSettings } from "@/components/custom-ui/ui-store/editor-settings-store"
import { useTextColors, setTextColor } from "@/components/custom-ui/ui-store/text-colors-store"
import { useZoom, zoomLevels, type ZoomLevel } from "@/components/custom-ui/ui-store/zoom-store"
import "./settings-menu.scss"

const categories = [
  { id: "general", label: "General", icon: RiUserLine },
  { id: "appearance", label: "Appearance", icon: RiPaletteLine },
  { id: "interface", label: "Interface", icon: RiLayoutLine },
  { id: "editor", label: "Editor", icon: RiEditLine },
] as const

type Category = typeof categories[number]["id"]

export function SettingsMenu({ name, onNameChange }: { name: string; onNameChange: (name: string) => void }) {
  const dialog = React.useRef<HTMLDialogElement>(null)
  const trigger = React.useRef<HTMLButtonElement>(null)
  const [open, setOpen] = React.useState(false)
  const [category, setCategory] = React.useState<Category>("general")
  const [query, setQuery] = React.useState("")
  const [draftName, setDraftName] = React.useState(name)
  const [theme, setTheme] = useTheme()
  const [colorTheme, setColorTheme] = useColorTheme()
  const textColors = useTextColors()
  const toolbarVisible = useToolbarVisible()
  const titleVisible = useInlineTitleVisible()
  const editorSettings = useEditorSettings()
  const [zoom, setZoom] = useZoom()

  React.useEffect(() => {
    if (open) dialog.current?.showModal()
    else if (dialog.current?.open) dialog.current.close()
  }, [open])

  const toggle = (id: string, value: boolean, onChange: (value: boolean) => void) => (
    <button id={id} type="button" className="settings-switch" role="switch" aria-checked={value}
      aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} onClick={() => onChange(!value)}>
      <span />
    </button>
  )
  const colorControl = (
    <div className="settings-color-control">
      <div className="settings-color-picker">
        <span className="settings-color-swatch" style={{ backgroundColor: textColors.title ?? "var(--tt-theme-text)" }} aria-hidden="true" />
        <span className="settings-color-value">{textColors.title?.toUpperCase() ?? "Theme default"}</span>
        <RiPaletteLine size={16} aria-hidden="true" />
        <input id="heading-color" type="color" value={textColors.title ?? "#808080"}
          aria-labelledby="heading-color-label" onChange={event => setTextColor(event.target.value)} />
      </div>
      <button type="button" aria-label="Reset title and subtitle color" disabled={!textColors.title} onClick={() => setTextColor(null)}>Reset</button>
    </div>
  )
  const settings: { id: string; category: Category; label: string; description: string; keywords?: string; control: React.ReactNode }[] = [
    { id: "display-name", category: "general", label: "Display name", description: "The name others see when you collaborate.", keywords: "profile identity user",
      control: <form className="settings-name" onSubmit={event => { event.preventDefault(); if (draftName.trim()) { onNameChange(draftName.trim()); setDraftName(draftName.trim()) } }}>
        <input id="display-name" aria-labelledby="display-name-label" value={draftName} maxLength={40} autoComplete="nickname" onChange={event => setDraftName(event.target.value)} />
        <button type="submit" disabled={!draftName.trim() || draftName.trim() === name}>Save</button>
      </form> },
    { id: "theme", category: "appearance", label: "Color mode", description: "Use a light, dark, or system-matched workspace.", keywords: "color mode",
      control: <select id="theme" value={theme} onChange={event => setTheme(event.target.value as Theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select> },
    { id: "color-theme", category: "appearance", label: "Color theme", description: "", keywords: "palette style classic sandstone forest rose ocean",
      control: <div className="theme-options" role="group" aria-labelledby="color-theme-label">
        {colorThemes.map(option => <button key={option.id} type="button" className="theme-option" aria-pressed={colorTheme === option.id} onClick={() => setColorTheme(option.id)}>
          <span className="theme-preview" data-color-theme={option.id} aria-hidden="true">
            <span className="theme-preview-sidebar"><i /><i /><i /></span>
            <span className="theme-preview-page"><i /><i /><i /><i /></span>
          </span>
          <span className="theme-option-name">{option.name}<span aria-hidden="true">{colorTheme === option.id ? "✓" : ""}</span></span>
        </button>)}
      </div> },
    { id: "heading-color", category: "appearance", label: "Title and subtitle color", description: "Note titles and all headings (H1-H6).", keywords: "text font subheading h1 h2 h3 h4 h5 h6",
      control: colorControl },
    { id: "zoom", category: "interface", label: "Zoom", description: "Scale the whole interface on this device.", keywords: "scale size magnify ui",
      control: <select id="zoom" value={zoom} onChange={event => setZoom(Number(event.target.value) as ZoomLevel)}>{zoomLevels.map(level => <option key={level} value={level}>{level}%</option>)}</select> },
    { id: "toolbar", category: "interface", label: "Formatting toolbar", description: "Show formatting tools above your note. Keyboard shortcuts stay available.",
      control: toggle("toolbar", toolbarVisible, setToolbarVisible) },
    { id: "inline-title", category: "interface", label: "Note title", description: "Show an editable title at the top of each note.", keywords: "inline heading",
      control: toggle("inline-title", titleVisible, setInlineTitleVisible) },
    { id: "font-size", category: "editor", label: "Text size", description: "Adjust the reading and writing size on this device.", keywords: "font zoom",
      control: <select id="font-size" value={editorSettings.fontSize} onChange={event => setEditorSettings({ fontSize: Number(event.target.value) })}>{[14, 16, 18, 20].map(size => <option key={size} value={size}>{size} px</option>)}</select> },
    { id: "spellcheck", category: "editor", label: "Spell check", description: "Use your browser's spell checker while writing.", keywords: "spelling language",
      control: toggle("spellcheck", editorSettings.spellcheck, spellcheck => setEditorSettings({ spellcheck })) },
  ]
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const searching = words.length > 0
  const results = settings.filter(setting => searching
    ? words.every(word => `${setting.label} ${setting.description} ${setting.keywords ?? ""} ${setting.category}`.toLowerCase().includes(word))
    : setting.category === category)
  const active = categories.find(item => item.id === category)!

  return <>
    <div className="ribbon-bottom">
      <Button ref={trigger} type="button" data-style="ghost" aria-label="Open settings" tooltip="Settings" aria-haspopup="dialog" onClick={() => { setDraftName(name); setQuery(""); setOpen(true) }}>
        <RiSettings3Line className="tiptap-button-icon settings-trigger-icon" />
      </Button>
    </div>
    {createPortal(<dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title"
      onCancel={() => setOpen(false)} onClose={() => { setOpen(false); trigger.current?.focus() }}
      onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setOpen(false) } }}>
      {open && <div className="settings-layout">
        <header className="settings-header"><h2 id="settings-title">Settings</h2><button type="button" className="settings-close" aria-label="Close settings" onClick={() => setOpen(false)}><RiCloseLine size={20} /></button></header>
        <aside className="settings-sidebar">
          <div className="settings-search"><RiSearchLine size={17} aria-hidden="true" /><input autoFocus type="search" aria-label="Search settings" placeholder="Search settings…" value={query} onChange={event => setQuery(event.target.value)} /></div>
          <nav aria-label="Settings categories">{categories.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={!searching && category === id ? "page" : undefined} onClick={() => { setCategory(id); setQuery("") }}><Icon size={18} aria-hidden="true" />{label}</button>)}</nav>
        </aside>
        <section className="settings-content" aria-label={searching ? "Search results" : active.label}>
          <h3>{searching ? "Search results" : active.label}</h3>
          {searching && <p className="settings-subtitle" role="status">{results.length} {results.length === 1 ? "setting" : "settings"} found</p>}
          {results.map(setting => <div className={`settings-row${setting.id === "color-theme" ? " settings-row--themes" : ""}`} key={setting.id}>
            <div className="settings-row-copy">{searching && <span className="settings-category-label">{categories.find(item => item.id === setting.category)?.label}</span>}<label id={`${setting.id}-label`} htmlFor={setting.id}>{setting.label}</label>{setting.description && <p id={`${setting.id}-description`}>{setting.description}</p>}</div>
            {setting.control}
          </div>)}
          {results.length === 0 && <div className="settings-empty"><RiSearchLine size={28} aria-hidden="true" /><h4>No matching settings</h4><p>Try “theme”, “toolbar”, or “spelling”.</p><button type="button" onClick={() => setQuery("")}>Clear search</button></div>}
        </section>
      </div>}
    </dialog>, document.body)}
  </>
}
