export interface WaitingState {
  waitedTooLong: boolean
  /** Whether any signaling server is reachable. */
  signaling: boolean
  peers: number
}

/**
 * Why nothing has arrived yet.
 *
 * Unreachable signaling, an absent owner and a slow transfer all look like
 * waiting, and they are not the same thing: the first is infrastructure the
 * reader cannot touch, the second is somebody else's doing, the third is fine.
 * Reporting them as one spinner is how a working code gets retyped.
 */
export function waitingMessage(state: WaitingState): string {
  if (!state.waitedTooLong) return "Connecting to the notebook…"
  if (!state.signaling) {
    return "This device cannot reach the service that introduces people to each other, so there is no way to find the notebook. Nothing you can do from here will fix it — tell whoever invited you."
  }
  if (state.peers === 0) {
    return "Connected, but nobody else is in this notebook right now. Whoever invited you has to have it open at the same time as you."
  }
  return "Connected to whoever invited you. Still waiting for the notebook itself to come across."
}

/**
 * The same question when the notebook comes through the relay.
 *
 * Nobody else has to be online, so an empty room is not a reason. Caught up
 * and still nothing means nothing was ever published - which is something the
 * inviter can fix at any time, not something both of them must fix together.
 */
export function relayWaitingMessage(state: {
  waitedTooLong: boolean
  status: "offline" | "connecting" | "live"
}): string {
  if (state.status === "live") {
    return "Nothing has been published for this notebook yet. Whoever invited you has to open it once with sync switched on — you do not both need to be online."
  }
  if (!state.waitedTooLong) return "Connecting to the notebook…"
  return "This device cannot reach the sync service, so there is no way to find the notebook. Nothing you can do from here will fix it — tell whoever invited you."
}
