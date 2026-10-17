/**
 * Telling a person's other devices about a notebook one of them just linked
 * them into.
 *
 * Each device has an inbox at the relay, found from its own sealing key - which
 * only devices that share a notebook with it know, and the relay does not. An
 * announcement is signed by the device sending it and sealed to the device it
 * is for, so the members who can find an inbox still cannot read it, and the
 * device reading it acts only on one from a device that is the same person.
 *
 * Each announcement sits in a slot only its sender can work out, so the sender
 * can tell whether it is still there without reading it, and put it back.
 */

import type * as Y from "yjs"

import { deriveKey, fromBase64Url, seal, toBase64Url, utf8, verifySignature, type Bytes, type SealingKey, type SigningKey } from "@/lib/crypto"
import { publicKeyFromDid } from "@/lib/identity"

import type { DirectoryChannel } from "./replicas"

const VERSION = 1
const ANNOUNCEMENTS = "announcements"

export interface AnnouncementBody {
  v: typeof VERSION
  notebookId: string
  name: string
  /** Its owner, as the sender established it. */
  owner: string
  /** The device sending it. */
  by: string
  /** The device it is for. */
  to: string
  at: number
}

export interface Announcement extends AnnouncementBody {
  sig: string
}

function bodyBytes(body: AnnouncementBody): Bytes {
  return utf8(
    ["synk/announcement/v1", String(body.v), body.notebookId, body.name, body.owner, body.by, body.to, String(body.at)].join("\n"),
  )
}

export async function signAnnouncement(
  signingKey: SigningKey,
  body: Omit<AnnouncementBody, "v" | "at"> & { at?: number },
): Promise<Announcement> {
  const full: AnnouncementBody = { v: VERSION, ...body, at: body.at ?? Date.now() }
  return { ...full, sig: toBase64Url(await signingKey.sign(bodyBytes(full))) }
}

/** Signed by the device it names as sender. Whether that device is to be believed is the reader's call. */
export async function verifyAnnouncement(announcement: Announcement): Promise<boolean> {
  try {
    if (announcement.v !== VERSION) return false
    const { sig, ...body } = announcement
    return await verifySignature(publicKeyFromDid(body.by, "ed25519"), bodyBytes(body), fromBase64Url(sig))
  } catch {
    return false
  }
}

/** A device's inbox at the relay, from its sealing key. */
export async function inboxChannel(sealingDid: string): Promise<DirectoryChannel> {
  const secret = utf8(`synk/inbox/${sealingDid}`)
  const id = await deriveKey(secret, "synk/inbox-resource/v1", 16)
  const dek = await deriveKey(secret, "synk/inbox-key/v1")
  return {
    resourceId: `inbox:${toBase64Url(id)}`,
    keys: {
      current: () => Promise.resolve({ epoch: 0, dek }),
      forEpoch: (epoch) => Promise.resolve(epoch === 0 ? dek : undefined),
    },
  }
}

/** Where a sender files a notebook for a device. Nobody else can tell what it names. */
export async function announcementSlot(signingKey: SigningKey, notebookId: string, to: string): Promise<string> {
  const tag = await signingKey.sign(utf8(`synk/announcement-slot/v1\n${notebookId}\n${to}`))
  return toBase64Url(await deriveKey(tag, "synk/announcement-slot/v1", 16))
}

export async function putAnnouncement(doc: Y.Doc, slot: string, recipientSealingDid: string, announcement: Announcement): Promise<void> {
  const box = await seal(publicKeyFromDid(recipientSealingDid, "x25519"), utf8(JSON.stringify(announcement)))
  doc.getMap<string>(ANNOUNCEMENTS).set(slot, toBase64Url(box))
}

export function hasAnnouncement(doc: Y.Doc, slot?: string): boolean {
  const map = doc.getMap<string>(ANNOUNCEMENTS)
  return slot === undefined ? map.size > 0 : map.has(slot)
}

/** Every announcement for this device that verifies and comes from a sender it believes. Anything else is skipped. */
export async function openAnnouncements(
  doc: Y.Doc,
  sealingKey: SealingKey,
  self: string,
  believes: (sender: string) => boolean,
): Promise<Announcement[]> {
  const opened: Announcement[] = []
  for (const box of doc.getMap<unknown>(ANNOUNCEMENTS).values()) {
    if (typeof box !== "string") continue
    try {
      const announcement = JSON.parse(new TextDecoder().decode(await sealingKey.open(fromBase64Url(box)))) as Announcement
      if (announcement.to !== self || !believes(announcement.by)) continue
      if (await verifyAnnouncement(announcement)) opened.push(announcement)
    } catch {
      // Not for this device, or not an announcement.
    }
  }
  return opened
}
