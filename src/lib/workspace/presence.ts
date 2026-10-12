/**
 * Where members' cursors meet, derived from the current epoch key.
 *
 * Presence still travels over WebRTC, and a room named after the notebook id
 * stays open to anyone who once held it - including someone since removed,
 * who would go on seeing names and cursors. Deriving the room from the epoch
 * key moves everyone to a new room at every cut, and a removed member cannot
 * compute the new one.
 */

import { deriveKey, toBase64Url, type Bytes } from "@/lib/crypto"

export interface PresenceRoom {
  /** Visible to the signaling server, so it names nothing. */
  name: string
  /** What y-webrtc encrypts the room's traffic under. */
  password: string
}

export async function presenceRoom(epochKey: Bytes, scope: string): Promise<PresenceRoom> {
  return {
    name: `synk:presence:${toBase64Url(await deriveKey(epochKey, `synk/presence-room/v1:${scope}`, 16))}`,
    password: toBase64Url(await deriveKey(epochKey, `synk/presence-password/v1:${scope}`, 32)),
  }
}

export const notePresenceScope = (notebookId: string, noteId: string) => `note:${notebookId}/${noteId}`
export const indexPresenceScope = (notebookId: string) => `index:${notebookId}`
