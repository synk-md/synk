/**
 * WebRTC signaling over the relay. The data channel itself is still deferred.
 *
 * A peer-to-peer mode does not make the server optional: two browsers behind
 * NAT cannot discover each other, and many need TURN to reach each other at
 * all. What changes is how much data crosses the relay, not whether it is
 * needed.
 */

import type { RelayClient } from "./client"
import type { TurnCredentials } from "./protocol"

export interface SignalMessage {
  kind: "offer" | "answer" | "ice"
  /** SDP or an ICE candidate, as the peers agree. Opaque to the relay. */
  data: string
  resourceId: string
}

export type SignalHandler = (from: string, message: SignalMessage) => void

/**
 * Offers, answers and candidates between two devices.
 *
 * Not encrypted or signed at this layer, deliberately: SDP reveals candidate
 * addresses to a relay that already sees the IP. A signal can start a
 * connection attempt and nothing else.
 */
export class SignalingChannel {
  private readonly client: RelayClient
  private readonly handlers = new Set<SignalHandler>()

  constructor(client: RelayClient) {
    this.client = client
  }

  /** Feed a push from the relay client in. */
  accept(from: string, payload: string): void {
    let message: SignalMessage
    try {
      const parsed: unknown = JSON.parse(payload)
      if (typeof parsed !== "object" || parsed === null) return
      message = parsed as SignalMessage
    } catch {
      return
    }
    if (message.kind !== "offer" && message.kind !== "answer" && message.kind !== "ice") return
    for (const handler of this.handlers) handler(from, message)
  }

  onSignal(handler: SignalHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  send(to: string, message: SignalMessage): Promise<boolean> {
    return this.client.sendSignal(to, JSON.stringify(message))
  }

  /**
   * ICE servers for an `RTCPeerConnection`. STUN alone when TURN is declined -
   * fewer connections, not a failure.
   */
  async iceServers(stun: readonly string[] = ["stun:stun.l.google.com:19302"]): Promise<RTCIceServer[]> {
    const servers: RTCIceServer[] = [{ urls: [...stun] }]
    const turn: TurnCredentials | undefined = await this.client.turnCredentials()
    if (turn) {
      servers.push({ urls: turn.urls, username: turn.username, credential: turn.credential })
    }
    return servers
  }
}
