import { describe, expect, it } from "vitest"
import { generateSealingKey, generateSigningKey, toBase64Url } from "@/lib/crypto"
import { admitDevice, newAdmin, newDeviceRecord, WORKSPACE } from "@/test/identity-fixtures"
import { didFromSigningKey } from "./did"
import { createDeviceRecord } from "./device-record"
import {
  admissionBytes,
  attestedLabel,
  createDeviceAdmission,
  DEVICE_ADMISSION_VERSION,
  verifyAdmittedDevice,
  verifyDeviceAdmission,
  type DeviceAdmission,
} from "./device-admission"

describe("createDeviceAdmission", () => {
  it("binds the device, its keys, the member, the label and the admin", async () => {
    const admin = await newAdmin()
    const { record, admission } = await admitDevice(admin)

    expect(admission.v).toBe(DEVICE_ADMISSION_VERSION)
    expect(admission.did).toBe(record.did)
    expect(admission.sealingDid).toBe(record.sealingDid)
    expect(admission.clientId).toBe(record.clientId)
    expect(admission.member).toBe("member:sindre")
    expect(admission.label).toBe("Sindre")
    expect(admission.workspace).toBe(WORKSPACE)
    expect(admission.admin).toBe(admin.did)
  })

  it("verifies against the admitting admin", async () => {
    const admin = await newAdmin()
    const { admission } = await admitDevice(admin)
    expect(await verifyDeviceAdmission(admission, [admin.did])).toBe(true)
  })

  it("trims and requires a label and a member", async () => {
    const admin = await newAdmin()
    const record = await newDeviceRecord()
    const base = {
      adminSigningKey: admin.key,
      adminDid: admin.did,
      record,
      workspace: WORKSPACE,
    }

    const admission = await createDeviceAdmission({
      ...base,
      member: "  member:x  ",
      label: "  Padded  ",
    })
    expect(admission.label).toBe("Padded")
    expect(admission.member).toBe("member:x")

    await expect(
      createDeviceAdmission({ ...base, member: "member:x", label: "   " }),
    ).rejects.toThrow(/non-empty human label/)
    await expect(
      createDeviceAdmission({ ...base, member: "  ", label: "Sindre" }),
    ).rejects.toThrow(/must name a member/)
  })

  // An admin cannot vouch for a key nobody has demonstrated possession of.
  it("refuses to admit a device whose record does not verify", async () => {
    const admin = await newAdmin()
    const record = await newDeviceRecord()
    await expect(
      createDeviceAdmission({
        adminSigningKey: admin.key,
        adminDid: admin.did,
        record: { ...record, clientId: record.clientId + 1 },
        member: "member:mallory",
        label: "Mallory",
        workspace: WORKSPACE,
      }),
    ).rejects.toThrow(/does not verify/)
  })

  it("refuses when the named admin is not the signing key", async () => {
    const admin = await newAdmin()
    const other = await newAdmin()
    await expect(
      createDeviceAdmission({
        adminSigningKey: admin.key,
        adminDid: other.did,
        record: await newDeviceRecord(),
        member: "member:sindre",
        label: "Sindre",
        workspace: WORKSPACE,
      }),
    ).rejects.toThrow(/does not match the supplied admin signing key/)
  })
})

describe("new people are admin-only", () => {
  // The property this module exists for: a stranger cannot admit themselves,
  // however well formed the admission they produce.
  it("rejects a self-signed admission from the device being admitted", async () => {
    const deviceKey = await generateSigningKey()
    const deviceDid = didFromSigningKey(deviceKey.publicKey)
    const record = await createDeviceRecord(deviceKey, await generateSealingKey())

    const selfAdmission = await createDeviceAdmission({
      adminSigningKey: deviceKey,
      adminDid: deviceDid,
      record,
      member: "member:mallory",
      label: "Definitely Legitimate",
      workspace: WORKSPACE,
    })

    const admin = await newAdmin()
    expect(await verifyDeviceAdmission(selfAdmission, [admin.did])).toBe(false)
    expect(await verifyAdmittedDevice({ record, admission: selfAdmission }, [admin.did])).toBe(
      false,
    )
  })

  it("rejects an admission from an admin outside the trusted set", async () => {
    const rogue = await newAdmin()
    const real = await newAdmin()
    const { admission } = await admitDevice(rogue)
    expect(await verifyDeviceAdmission(admission, [real.did])).toBe(false)
    expect(await verifyDeviceAdmission(admission, [])).toBe(false)
  })

  it("accepts any admin in the trusted set", async () => {
    const first = await newAdmin()
    const second = await newAdmin()
    const { admission } = await admitDevice(second)
    expect(await verifyDeviceAdmission(admission, [first.did, second.did])).toBe(true)
  })
})

describe("verifyDeviceAdmission rejection", () => {
  it("rejects tampered fields", async () => {
    const admin = await newAdmin()
    const { admission } = await admitDevice(admin)
    const trusted = [admin.did]

    expect(await verifyDeviceAdmission({ ...admission, label: "Someone Else" }, trusted)).toBe(false)
    expect(await verifyDeviceAdmission({ ...admission, member: "member:other" }, trusted)).toBe(
      false,
    )
    expect(
      await verifyDeviceAdmission({ ...admission, workspace: "workspace:other" }, trusted),
    ).toBe(false)
    expect(
      await verifyDeviceAdmission({ ...admission, clientId: admission.clientId + 1 }, trusted),
    ).toBe(false)
    expect(
      await verifyDeviceAdmission({ ...admission, sig: toBase64Url(new Uint8Array(64)) }, trusted),
    ).toBe(false)
  })

  it("enforces the workspace scope when asked", async () => {
    const admin = await newAdmin()
    const { admission } = await admitDevice(admin)
    expect(await verifyDeviceAdmission(admission, [admin.did], { workspace: WORKSPACE })).toBe(true)
    expect(
      await verifyDeviceAdmission(admission, [admin.did], { workspace: "workspace:other" }),
    ).toBe(false)
  })

  it("rejects an unknown version and malformed input", async () => {
    const admin = await newAdmin()
    const { admission } = await admitDevice(admin)
    expect(await verifyDeviceAdmission({ ...admission, v: 2 as 1 }, [admin.did])).toBe(false)
    expect(await verifyDeviceAdmission({ ...admission, did: "not-a-did" }, [admin.did])).toBe(false)
    expect(await verifyDeviceAdmission({ ...admission, admin: "not-a-did" }, ["not-a-did"])).toBe(
      false,
    )
    expect(await verifyDeviceAdmission({} as DeviceAdmission, [admin.did])).toBe(false)
  })

  it("rejects a signing DID in the sealing slot", async () => {
    const admin = await newAdmin()
    const { admission } = await admitDevice(admin)
    expect(
      await verifyDeviceAdmission({ ...admission, sealingDid: admission.did }, [admin.did]),
    ).toBe(false)
  })
})

describe("admissionBytes", () => {
  it("is insensitive to property order but sensitive to every field", async () => {
    const admin = await newAdmin()
    const { admission } = await admitDevice(admin)
    const body = {
      v: admission.v,
      did: admission.did,
      sealingDid: admission.sealingDid,
      clientId: admission.clientId,
      member: admission.member,
      label: admission.label,
      workspace: admission.workspace,
      admin: admission.admin,
      issuedAt: admission.issuedAt,
    }
    const reordered = {
      issuedAt: body.issuedAt,
      admin: body.admin,
      workspace: body.workspace,
      label: body.label,
      member: body.member,
      clientId: body.clientId,
      sealingDid: body.sealingDid,
      did: body.did,
      v: body.v,
    }
    expect(toBase64Url(admissionBytes(reordered))).toBe(toBase64Url(admissionBytes(body)))
    expect(toBase64Url(admissionBytes({ ...body, label: "x" }))).not.toBe(
      toBase64Url(admissionBytes(body)),
    )
    expect(toBase64Url(admissionBytes({ ...body, member: "member:x" }))).not.toBe(
      toBase64Url(admissionBytes(body)),
    )
  })
})

describe("verifyAdmittedDevice", () => {
  it("requires possession and admission together", async () => {
    const admin = await newAdmin()
    const device = await admitDevice(admin)
    expect(await verifyAdmittedDevice(device, [admin.did])).toBe(true)
    expect(attestedLabel(device)).toBe("Sindre")
  })

  // An admin vouching for a sealing key the device does not hold would surface
  // much later as an undecryptable epoch key. Caught here instead.
  it("rejects a record and admission that disagree", async () => {
    const admin = await newAdmin()
    const mine = await admitDevice(admin)
    const theirs = await admitDevice(admin)

    expect(
      await verifyAdmittedDevice({ record: mine.record, admission: theirs.admission }, [admin.did]),
    ).toBe(false)
    expect(
      await verifyAdmittedDevice(
        {
          record: mine.record,
          admission: { ...mine.admission, sealingDid: theirs.record.sealingDid },
        },
        [admin.did],
      ),
    ).toBe(false)
  })

  it("rejects a valid admission paired with an unverifiable record", async () => {
    const admin = await newAdmin()
    const { record, admission } = await admitDevice(admin)
    expect(
      await verifyAdmittedDevice(
        { record: { ...record, createdAt: record.createdAt + 1 }, admission },
        [admin.did],
      ),
    ).toBe(false)
  })
})
