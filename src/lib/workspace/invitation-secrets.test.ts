import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  forgetInvitationCode,
  forgetNotebookCodes,
  pruneInvitationCodes,
  recallInvitationCode,
  rememberInvitationCode,
} from "./invitation-secrets"

const NOTEBOOK = "travel"

beforeEach(() => {
  localStorage.clear()
})

describe("invitation codes on the issuing device", () => {
  it("can be read again after the dialog is gone", () => {
    rememberInvitationCode(NOTEBOOK, "inv-1", "ABCD-EFGH")
    expect(recallInvitationCode(NOTEBOOK, "inv-1")).toBe("ABCD-EFGH")
  })

  it("keeps notebooks apart", () => {
    rememberInvitationCode(NOTEBOOK, "inv-1", "ABCD")
    expect(recallInvitationCode("other", "inv-1")).toBeNull()
  })

  /** Past the point of use, keeping it is the one version with no upside. */
  it("is dropped once its invitation is spent", () => {
    rememberInvitationCode(NOTEBOOK, "inv-1", "ABCD")
    rememberInvitationCode(NOTEBOOK, "inv-2", "EFGH")

    forgetInvitationCode(NOTEBOOK, "inv-1")

    expect(recallInvitationCode(NOTEBOOK, "inv-1")).toBeNull()
    expect(recallInvitationCode(NOTEBOOK, "inv-2")).toBe("EFGH")
  })

  it("drops everything for a notebook at once", () => {
    rememberInvitationCode(NOTEBOOK, "inv-1", "ABCD")
    rememberInvitationCode("other", "inv-2", "EFGH")

    forgetNotebookCodes(NOTEBOOK)

    expect(recallInvitationCode(NOTEBOOK, "inv-1")).toBeNull()
    expect(recallInvitationCode("other", "inv-2")).toBe("EFGH")
  })

  it("prunes codes whose invitations are no longer live", () => {
    rememberInvitationCode(NOTEBOOK, "live", "ABCD")
    rememberInvitationCode(NOTEBOOK, "gone", "EFGH")

    pruneInvitationCodes(NOTEBOOK, ["live"])

    expect(recallInvitationCode(NOTEBOOK, "live")).toBe("ABCD")
    expect(recallInvitationCode(NOTEBOOK, "gone")).toBeNull()
  })

  /** A missing code is a degraded invitation, not a broken app. */
  it("returns null rather than throwing when storage is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled")
    })
    try {
      expect(recallInvitationCode(NOTEBOOK, "inv-1")).toBeNull()
      expect(() => rememberInvitationCode(NOTEBOOK, "inv-1", "ABCD")).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
})
