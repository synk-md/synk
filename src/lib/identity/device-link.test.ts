import { describe, expect, it } from "vitest"
import { toBase64Url } from "@/lib/crypto"
import { admitDevice, linkDevice, newAdmin, newDevice, WORKSPACE } from "@/test/identity-fixtures"
import { createDeviceLink, DEVICE_LINK_VERSION, LEAF_DEPTH, linkBytes, verifyDeviceLink, verifyLinkedDevice, type DeviceLink } from "./device-link"

describe("createDeviceLink", () => {
  it("inherits member and workspace from the parent's admission", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin, { member: "member:sindre" })
    const linked = await linkDevice(parent)

    expect(linked.link.v).toBe(DEVICE_LINK_VERSION)
    expect(linked.link.did).toBe(linked.record.did)
    expect(linked.link.member).toBe(parent.admission.member)
    expect(linked.link.workspace).toBe(parent.admission.workspace)
    expect(linked.link.parent).toBe(parent.admission.did)
  })

  // The containment property: a linked device is a leaf and cannot delegate on.
  it("is always a non-delegable leaf", async () => {
    const admin = await newAdmin()
    const linked = await linkDevice(await admitDevice(admin))
    expect(linked.link.depth).toBe(LEAF_DEPTH)
    expect(linked.link.depth).toBe(0)
  })

  // No label field at all, so the self-service path cannot rename the member.
  it("carries no label", async () => {
    const admin = await newAdmin()
    const linked = await linkDevice(await admitDevice(admin))
    expect(linked.link).not.toHaveProperty("label")
  })

  it("refuses to link a device whose record does not verify", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin)
    const { record } = await newDevice()
    await expect(
      createDeviceLink({
        parentSigningKey: parent.key,
        parentAdmission: parent.admission,
        record: { ...record, clientId: record.clientId + 1 },
      }),
    ).rejects.toThrow(/does not verify/)
  })

  it("refuses when the parent admission is not the signing key", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin)
    const other = await admitDevice(admin)
    const { record } = await newDevice()
    await expect(
      createDeviceLink({
        parentSigningKey: parent.key,
        parentAdmission: other.admission,
        record,
      }),
    ).rejects.toThrow(/does not match the supplied parent signing key/)
  })

  it("refuses to link a device to itself", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin)
    await expect(
      createDeviceLink({
        parentSigningKey: parent.key,
        parentAdmission: parent.admission,
        record: parent.record,
      }),
    ).rejects.toThrow(/cannot link itself/)
  })
})

describe("self-service linking works", () => {
  // The exit criterion: a member adds their own second browser, no admin.
  it("verifies a member-added device with no admin involvement", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const phone = await linkDevice(laptop)

    expect(await verifyLinkedDevice(phone, laptop, [admin.did])).toBe(true)
    expect(await verifyDeviceLink(phone.link, laptop, [admin.did])).toBe(true)
  })

  it("lets one parent link several devices", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const phone = await linkDevice(laptop)
    const tablet = await linkDevice(laptop)

    expect(await verifyLinkedDevice(phone, laptop, [admin.did])).toBe(true)
    expect(await verifyLinkedDevice(tablet, laptop, [admin.did])).toBe(true)
    expect(phone.record.did).not.toBe(tablet.record.did)
  })
})

describe("the link is rooted in a real admission", () => {
  // A link is only as good as the admission behind it.
  it("rejects a link whose parent is not admitted by a trusted admin", async () => {
    const rogueAdmin = await newAdmin()
    const realAdmin = await newAdmin()
    const parent = await admitDevice(rogueAdmin)
    const linked = await linkDevice(parent)

    expect(await verifyLinkedDevice(linked, parent, [realAdmin.did])).toBe(false)
    expect(await verifyLinkedDevice(linked, parent, [rogueAdmin.did])).toBe(true)
  })

  it("rejects a link checked against the wrong parent", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin)
    const stranger = await admitDevice(admin)
    const linked = await linkDevice(parent)

    expect(await verifyLinkedDevice(linked, stranger, [admin.did])).toBe(false)
  })

  it("rejects a link whose parent's own record was tampered with", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin)
    const linked = await linkDevice(parent)
    const brokenParent = {
      record: { ...parent.record, createdAt: parent.record.createdAt + 1 },
      admission: parent.admission,
    }
    expect(await verifyLinkedDevice(linked, brokenParent, [admin.did])).toBe(false)
  })
})

describe("the leaf cannot widen its own scope", () => {
  it("rejects a link claiming a different member than its parent", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin, { member: "member:sindre" })
    const linked = await linkDevice(parent)

    expect(
      await verifyDeviceLink({ ...linked.link, member: "member:someone-else" }, parent, [
        admin.did,
      ]),
    ).toBe(false)
  })

  it("rejects a link claiming a different workspace than its parent", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin)
    const linked = await linkDevice(parent)

    expect(
      await verifyDeviceLink({ ...linked.link, workspace: "workspace:other" }, parent, [admin.did]),
    ).toBe(false)
  })

  // Rejected outright rather than clamped: claiming depth at all signals a
  // different model than the one this code implements.
  it("rejects a link claiming a delegable depth", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin)
    const linked = await linkDevice(parent)

    expect(
      await verifyDeviceLink({ ...linked.link, depth: 1 as 0 }, parent, [admin.did]),
    ).toBe(false)
  })

  it("rejects a client id the linked key does not derive", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin)
    const linked = await linkDevice(parent)

    expect(
      await verifyDeviceLink({ ...linked.link, clientId: linked.link.clientId + 1 }, parent, [
        admin.did,
      ]),
    ).toBe(false)
  })

  it("enforces the workspace scope when asked", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin)
    const linked = await linkDevice(parent)

    expect(await verifyLinkedDevice(linked, parent, [admin.did], { workspace: WORKSPACE })).toBe(
      true,
    )
    expect(
      await verifyLinkedDevice(linked, parent, [admin.did], { workspace: "workspace:other" }),
    ).toBe(false)
  })
})

describe("verifyDeviceLink rejection", () => {
  it("rejects a tampered signature and an unknown version", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin)
    const linked = await linkDevice(parent)

    expect(
      await verifyDeviceLink({ ...linked.link, sig: toBase64Url(new Uint8Array(64)) }, parent, [
        admin.did,
      ]),
    ).toBe(false)
    expect(await verifyDeviceLink({ ...linked.link, v: 2 as 1 }, parent, [admin.did])).toBe(false)
    expect(await verifyDeviceLink({} as DeviceLink, parent, [admin.did])).toBe(false)
  })

  it("rejects a record and link that disagree", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin)
    const phone = await linkDevice(parent)
    const tablet = await linkDevice(parent)

    expect(await verifyLinkedDevice({ record: phone.record, link: tablet.link }, parent, [admin.did]))
      .toBe(false)
  })

  it("rejects a signing DID in the sealing slot", async () => {
    const admin = await newAdmin()
    const parent = await admitDevice(admin)
    const linked = await linkDevice(parent)
    expect(
      await verifyDeviceLink({ ...linked.link, sealingDid: linked.link.did }, parent, [admin.did]),
    ).toBe(false)
  })
})

describe("linkBytes", () => {
  it("is insensitive to property order but sensitive to every field", async () => {
    const admin = await newAdmin()
    const linked = await linkDevice(await admitDevice(admin))
    const body = {
      v: linked.link.v,
      did: linked.link.did,
      sealingDid: linked.link.sealingDid,
      clientId: linked.link.clientId,
      member: linked.link.member,
      workspace: linked.link.workspace,
      parent: linked.link.parent,
      depth: linked.link.depth,
      issuedAt: linked.link.issuedAt,
    }
    const reordered = {
      issuedAt: body.issuedAt,
      depth: body.depth,
      parent: body.parent,
      workspace: body.workspace,
      member: body.member,
      clientId: body.clientId,
      sealingDid: body.sealingDid,
      did: body.did,
      v: body.v,
    }
    expect(toBase64Url(linkBytes(reordered))).toBe(toBase64Url(linkBytes(body)))
    expect(toBase64Url(linkBytes({ ...body, member: "member:x" }))).not.toBe(
      toBase64Url(linkBytes(body)),
    )
    expect(toBase64Url(linkBytes({ ...body, parent: body.did }))).not.toBe(
      toBase64Url(linkBytes(body)),
    )
  })
})
