/**
 * Several sequence spaces for one device.
 *
 * Envelopes are numbered per author, and two tabs of one device writing a
 * document with no writer lock would hand out the same numbers - one of each
 * pair silently dropped. An author of `did#lane` gives each session its own
 * numbering while every check still applies to the device: the author string
 * is signed, so only that device can write in any of its lanes.
 */

import type { AuthorResolver, WritePolicy } from "./sync-engine"

/** The device a laned author string belongs to. */
export function laneOwner(author: string): string {
  const hash = author.indexOf("#")
  return hash < 0 ? author : author.slice(0, hash)
}

export function newLane(did: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `${did}#${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

export function lanedAuthors(inner: AuthorResolver): AuthorResolver {
  return { resolve: (author) => inner.resolve(laneOwner(author)) }
}

export function lanedPolicy(inner: WritePolicy): WritePolicy {
  return { canWrite: (resourceId, author) => inner.canWrite(resourceId, laneOwner(author)) }
}
