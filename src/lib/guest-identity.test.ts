import { describe, expect, it, beforeEach } from "vitest"
import {
  getRandomColor,
  getRandomName,
  getInitialUser,
  getOrCreateGuestIdentity,
  setGuestName,
} from "./guest-identity"

beforeEach(() => {
  localStorage.clear()
})

describe("getRandomColor / getRandomName", () => {
  it("always returns a non-empty string", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(getRandomColor().length).toBeGreaterThan(0)
      expect(getRandomName().length).toBeGreaterThan(0)
    }
  })
})

describe("getInitialUser", () => {
  it("returns a name and color without touching localStorage", () => {
    const user = getInitialUser()
    expect(user.name).toBeTypeOf("string")
    expect(user.color).toBeTypeOf("string")
    expect(localStorage.length).toBe(0)
  })
})

describe("getOrCreateGuestIdentity", () => {
  it("generates and persists a new identity on first call", () => {
    const identity = getOrCreateGuestIdentity()
    expect(localStorage.getItem("tt:guestName")).toBe(identity.name)
    expect(localStorage.getItem("tt:guestColor")).toBe(identity.color)
  })

  it("returns the same identity on subsequent calls", () => {
    const first = getOrCreateGuestIdentity()
    const second = getOrCreateGuestIdentity()
    expect(second).toEqual(first)
  })

  it("fills in only the missing half when one of name/color was already stored", () => {
    localStorage.setItem("tt:guestName", "Existing Name")
    const identity = getOrCreateGuestIdentity()
    expect(identity.name).toBe("Existing Name")
    expect(identity.color).toBeTypeOf("string")
    expect(localStorage.getItem("tt:guestColor")).toBe(identity.color)
  })
})

describe("setGuestName", () => {
  it("stores a trimmed name", () => {
    setGuestName("  Alice  ")
    expect(localStorage.getItem("tt:guestName")).toBe("Alice")
  })

  it("ignores a blank/whitespace-only name", () => {
    localStorage.setItem("tt:guestName", "Original")
    setGuestName("   ")
    expect(localStorage.getItem("tt:guestName")).toBe("Original")
  })
})
