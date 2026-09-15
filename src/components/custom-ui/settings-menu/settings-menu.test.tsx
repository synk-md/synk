import { fireEvent, render, screen, cleanup } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { setTextColor } from "@/components/custom-ui/ui-store/text-colors-store"
import { SettingsMenu } from "./settings-menu"
import { getTheme, setTheme, getColorTheme, setColorTheme } from "@/components/custom-ui/ui-store/theme-store"
import { getToolbarVisible, setToolbarVisible } from "@/components/custom-ui/ui-store/ui-store"
import { getZoom, setZoom } from "@/components/custom-ui/ui-store/zoom-store"
import { setEditorSettings } from "@/components/custom-ui/ui-store/editor-settings-store"

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")) }
})
afterEach(() => { cleanup(); setTextColor(null); setTheme("system"); setColorTheme("classic"); setToolbarVisible(true); setZoom(100); setEditorSettings({ lineWidth: "medium" }) })
function openSettings() {
  const onNameChange = vi.fn()
  render(<SettingsMenu name="River" onNameChange={onNameChange} />)
  fireEvent.click(screen.getByRole("button", { name: "Open settings" }))
  return onNameChange
}

describe("Settings menu", () => {
  it("searches across categories, handles no results, and clears search when navigating", () => {
    openSettings()
    const search = screen.getByRole("searchbox", { name: "Search settings" })
    fireEvent.change(search, { target: { value: "spelling" } })
    expect(screen.getByRole("switch", { name: "Spell check" })).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("1 setting found")
    fireEvent.change(search, { target: { value: "unknown option" } })
    expect(screen.getByText("No matching settings")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }))
    expect(search).toHaveValue("")
    expect(screen.getByLabelText("Color mode")).toBeInTheDocument()
  })

  it("updates the existing theme and toolbar preferences", () => {
    openSettings()
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }))
    fireEvent.change(screen.getByLabelText("Color mode"), { target: { value: "dark" } })
    expect(getTheme()).toBe("dark")
    expect(document.documentElement).toHaveClass("dark")
    fireEvent.click(screen.getByRole("button", { name: "Interface" }))
    fireEvent.click(screen.getByRole("switch", { name: "Formatting toolbar" }))
    expect(getToolbarVisible()).toBe(false)
    expect(localStorage.getItem("tt:toolbarVisible")).toBe("0")
  })

  it("zooms the whole interface and restores the default", () => {
    openSettings()
    fireEvent.click(screen.getByRole("button", { name: "Interface" }))
    fireEvent.change(screen.getByLabelText("Zoom"), { target: { value: "125" } })
    expect(getZoom()).toBe(125)
    expect(localStorage.getItem("tt:zoom")).toBe("125")
    expect(document.documentElement.style.getPropertyValue("--app-zoom")).toBe("1.25")
    fireEvent.change(screen.getByLabelText("Zoom"), { target: { value: "100" } })
    expect(document.documentElement.style.getPropertyValue("--app-zoom")).toBe("1")
  })

  it("changes and saves the line length", () => {
    openSettings()
    fireEvent.click(screen.getByRole("button", { name: "Editor" }))
    fireEvent.change(screen.getByLabelText("Line length"), { target: { value: "wide" } })
    expect(screen.getByLabelText("Line length")).toHaveValue("wide")
    expect(JSON.parse(localStorage.getItem("tt:editorSettings")!).lineWidth).toBe("wide")
  })

  it("applies a color palette across the app and preserves it when changing color mode", () => {
    openSettings()
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }))
    fireEvent.click(screen.getByRole("button", { name: "Forest" }))
    expect(getColorTheme()).toBe("forest")
    expect(document.documentElement).toHaveAttribute("data-color-theme", "forest")
    expect(localStorage.getItem("tt:colorTheme")).toBe("forest")
    fireEvent.change(screen.getByLabelText("Color mode"), { target: { value: "dark" } })
    expect(document.documentElement).toHaveClass("dark")
    expect(document.documentElement).toHaveAttribute("data-color-theme", "forest")
    expect(screen.getByRole("button", { name: "Forest" })).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByRole("button", { name: "Classic" }))
    expect(document.documentElement).toHaveAttribute("data-color-theme", "classic")
    expect(document.documentElement).toHaveClass("dark")
  })

  it("finds color themes by name from another category", () => {
    openSettings()
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "sandstone" } })
    expect(screen.getByRole("button", { name: "Sandstone" })).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("1 setting found")
  })

  it("applies one color to titles and subtitles and resets to the theme default", () => {
    openSettings()
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }))
    fireEvent.change(screen.getByLabelText("Title and subtitle color"), { target: { value: "#aa4422" } })
    expect(document.documentElement.style.getPropertyValue("--custom-title-color")).toBe("#aa4422")
    expect(document.documentElement.style.getPropertyValue("--custom-subtitle-color")).toBe("#aa4422")
    expect(JSON.parse(localStorage.getItem("tt:textColors")!)).toEqual({ title: "#aa4422", subtitle: "#aa4422" })
    fireEvent.click(screen.getByRole("button", { name: "Forest" }))
    expect(screen.getByLabelText("Title and subtitle color")).toHaveValue("#aa4422")
    fireEvent.click(screen.getByRole("button", { name: "Reset title and subtitle color" }))
    expect(document.documentElement.style.getPropertyValue("--custom-title-color")).toBe("")
    expect(document.documentElement.style.getPropertyValue("--custom-subtitle-color")).toBe("")
  })

  it("saves a trimmed display name and restores focus after closing", () => {
    const onNameChange = openSettings()
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "  Alex  " } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onNameChange).toHaveBeenCalledWith("Alex")
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Open settings" })).toHaveFocus()
  })
})
