import { describe, expect, it } from "vitest"
import {
  admitDevice,
  asAdmitted,
  asLinked,
  linkDevice,
  newAdmin,
  WORKSPACE,
} from "@/test/identity-fixtures"
import {
  addDevice,
  admittedDevices,
  canSelfLink,
  createUser,
  findDeviceByClientId,
  findDeviceByDid,
  findUserByDeviceDid,
  hasDevice,
  memberOf,
  removeDevice,
  userLabel,
  userLabelOrThrow,
  verifyUser,
  type MemberDevice,
} from "./user"

describe("createUser", () => {
  it("groups admitted and linked devices under one user", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const phone = await linkDevice(laptop)
    const user = createUser("u1", [asAdmitted(laptop), asLinked(phone)])

    expect(user.devices).toHaveLength(2)
    expect(hasDevice(user, laptop.record.did)).toBe(true)
    expect(hasDevice(user, phone.record.did)).toBe(true)
  })

  it("resolves the member identity by either path", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin, { member: "member:maren" })
    const phone = await linkDevice(laptop)

    expect(memberOf(asAdmitted(laptop))).toBe("member:maren")
    expect(memberOf(asLinked(phone))).toBe("member:maren")
  })

  it("rejects colliding client ids up front", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const other = await admitDevice(admin)
    const clash: MemberDevice = {
      kind: "admitted",
      record: { ...other.record, clientId: laptop.record.clientId },
      admission: other.admission,
    }
    expect(() => createUser("u1", [asAdmitted(laptop), clash])).toThrow(/client id collision/)
  })
})

describe("addDevice / removeDevice", () => {
  it("adds without mutating the original", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const user = createUser("u1", [asAdmitted(laptop)])
    const next = addDevice(user, asLinked(await linkDevice(laptop)))
    expect(user.devices).toHaveLength(1)
    expect(next.devices).toHaveLength(2)
  })

  it("replaces an existing entry for the same did", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const user = createUser("u1", [asAdmitted(laptop)])
    const again = addDevice(user, asAdmitted(laptop))
    expect(again.devices).toHaveLength(1)
  })

  it("removes by did", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const phone = await linkDevice(laptop)
    const user = removeDevice(
      createUser("u1", [asAdmitted(laptop), asLinked(phone)]),
      phone.record.did,
    )
    expect(hasDevice(user, phone.record.did)).toBe(false)
    expect(hasDevice(user, laptop.record.did)).toBe(true)
  })
})

describe("lookup", () => {
  it("resolves a did and a client id to the right device", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const phone = await linkDevice(laptop)
    const user = createUser("u1", [asAdmitted(laptop), asLinked(phone)])

    expect(findDeviceByDid(user, phone.record.did)?.record.did).toBe(phone.record.did)
    // The lookup attribution depends on - sound only because the client id is
    // derived from the device key rather than claimed by anyone.
    expect(findDeviceByClientId(user, phone.record.clientId)?.record.did).toBe(phone.record.did)
    expect(findDeviceByClientId(user, 0)).toBeUndefined()
  })

  it("finds the user owning a device", async () => {
    const admin = await newAdmin()
    const mine = await admitDevice(admin, { member: "member:maren" })
    const theirs = await admitDevice(admin, { member: "member:ada", label: "Ada" })
    const users = [createUser("me", [asAdmitted(mine)]), createUser("them", [asAdmitted(theirs)])]

    expect(findUserByDeviceDid(users, theirs.record.did)?.userId).toBe("them")
    expect(findUserByDeviceDid(users, "did:key:z6MkUnknown")).toBeUndefined()
  })
})

describe("canSelfLink", () => {
  // Surfaces the designed fallback before a member is stranded, not after.
  it("is true while an admin-admitted device remains", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const phone = await linkDevice(laptop)
    const user = createUser("u1", [asAdmitted(laptop), asLinked(phone)])

    expect(canSelfLink(user)).toBe(true)
    expect(admittedDevices(user)).toHaveLength(1)
  })

  it("is false once only linked devices are left", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const phone = await linkDevice(laptop)
    const user = removeDevice(
      createUser("u1", [asAdmitted(laptop), asLinked(phone)]),
      laptop.record.did,
    )

    expect(user.devices).toHaveLength(1)
    expect(canSelfLink(user)).toBe(false)
  })
})

describe("userLabel", () => {
  // Admin-attested, never self-chosen and never restated by a link.
  it("reads the admin attestation and ignores linked devices", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin, { label: "Maren" })
    const phone = await linkDevice(laptop)
    expect(userLabel(createUser("u1", [asAdmitted(laptop), asLinked(phone)]))).toEqual({
      status: "attested",
      label: "Maren",
    })
  })

  it("reports none with no admin-admitted device", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const phone = await linkDevice(laptop)
    expect(userLabel(createUser("u1", [asLinked(phone)]))).toEqual({ status: "none" })
    expect(userLabel(createUser("u1"))).toEqual({ status: "none" })
  })

  // A conflict must be visible in the byline it concerns, not an exception that
  // takes down every view containing that byline.
  it("reports a conflict as a value rather than throwing", async () => {
    const admin = await newAdmin()
    const user = createUser("u1", [
      asAdmitted(await admitDevice(admin, { label: "Maren" })),
      asAdmitted(await admitDevice(admin, { label: "Someone Else" })),
    ])

    expect(() => userLabel(user)).not.toThrow()
    expect(userLabel(user)).toEqual({
      status: "conflicted",
      labels: ["Maren", "Someone Else"].sort(),
    })
  })

  it("orders conflicting labels deterministically", async () => {
    const admin = await newAdmin()
    const a = asAdmitted(await admitDevice(admin, { label: "Zoe" }))
    const b = asAdmitted(await admitDevice(admin, { label: "Ada" }))

    const oneWay = userLabel(createUser("u1", [a, b]))
    const other = userLabel(createUser("u1", [b, a]))
    expect(oneWay).toEqual(other)
    expect(oneWay).toEqual({ status: "conflicted", labels: ["Ada", "Zoe"] })
  })

  // Never render this one, but an import or operator tool should stop.
  it("userLabelOrThrow is the strict variant for non-render paths", async () => {
    const admin = await newAdmin()
    const ok = createUser("u1", [asAdmitted(await admitDevice(admin, { label: "Maren" }))])
    expect(userLabelOrThrow(ok)).toBe("Maren")
    expect(userLabelOrThrow(createUser("u2"))).toBeUndefined()

    const conflicted = createUser("u3", [
      asAdmitted(await admitDevice(admin, { label: "Maren" })),
      asAdmitted(await admitDevice(admin, { label: "Someone Else" })),
    ])
    expect(() => userLabelOrThrow(conflicted)).toThrow(/conflicting admin-attested labels/)
  })
})

describe("verifyUser", () => {
  it("accepts a member with an admitted device and their own self-linked ones", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const phone = await linkDevice(laptop)
    const tablet = await linkDevice(laptop)
    const user = createUser("u1", [asAdmitted(laptop), asLinked(phone), asLinked(tablet)])

    expect(await verifyUser(user, [admin.did])).toBe(true)
  })

  it("accepts a user with no devices", async () => {
    expect(await verifyUser(createUser("u1"), [])).toBe(true)
  })

  // A linked device is only valid alongside its parent. Lifting it out of the
  // set it was issued in must not verify.
  it("rejects a linked device whose parent is absent from the set", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const phone = await linkDevice(laptop)

    expect(await verifyUser(createUser("u1", [asLinked(phone)]), [admin.did])).toBe(false)
  })

  // The replay this guards: a link from one member's parent pasted into
  // another member's device set.
  it("rejects a linked device replayed into another member's set", async () => {
    const admin = await newAdmin()
    const marenLaptop = await admitDevice(admin, { member: "member:maren" })
    const adaLaptop = await admitDevice(admin, { member: "member:ada", label: "Ada" })
    const marenPhone = await linkDevice(marenLaptop)

    const adaWithStolenLink = createUser("ada", [asAdmitted(adaLaptop), asLinked(marenPhone)])
    expect(await verifyUser(adaWithStolenLink, [admin.did])).toBe(false)
  })

  it("rejects devices admitted by an untrusted admin", async () => {
    const real = await newAdmin()
    const rogue = await newAdmin()
    const user = createUser("u1", [
      asAdmitted(await admitDevice(real)),
      asAdmitted(await admitDevice(rogue)),
    ])

    expect(await verifyUser(user, [real.did])).toBe(false)
    expect(await verifyUser(user, [real.did, rogue.did])).toBe(true)
  })

  it("rejects a linked device whose parent was admitted by an untrusted admin", async () => {
    const rogue = await newAdmin()
    const real = await newAdmin()
    const laptop = await admitDevice(rogue)
    const phone = await linkDevice(laptop)
    const user = createUser("u1", [asAdmitted(laptop), asLinked(phone)])

    expect(await verifyUser(user, [real.did])).toBe(false)
  })

  it("rejects a device whose record no longer verifies", async () => {
    const admin = await newAdmin()
    const good = await admitDevice(admin)
    const broken = await admitDevice(admin)
    const tampered: MemberDevice = {
      kind: "admitted",
      record: { ...broken.record, createdAt: broken.record.createdAt + 1 },
      admission: broken.admission,
    }
    expect(await verifyUser({ userId: "u1", devices: [asAdmitted(good), tampered] }, [admin.did]))
      .toBe(false)
  })

  it("enforces workspace scope when asked", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const phone = await linkDevice(laptop)
    const user = createUser("u1", [asAdmitted(laptop), asLinked(phone)])

    expect(await verifyUser(user, [admin.did], { workspace: WORKSPACE })).toBe(true)
    expect(await verifyUser(user, [admin.did], { workspace: "workspace:other" })).toBe(false)
  })

  it("rejects colliding client ids assembled around the constructor", async () => {
    const admin = await newAdmin()
    const laptop = await admitDevice(admin)
    const other = await admitDevice(admin)
    const clash: MemberDevice = {
      kind: "admitted",
      record: { ...other.record, clientId: laptop.record.clientId },
      admission: other.admission,
    }
    expect(await verifyUser({ userId: "u1", devices: [asAdmitted(laptop), clash] }, [admin.did]))
      .toBe(false)
  })
})
