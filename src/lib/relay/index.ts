/**
 * Relay and server (milestone M9).
 *
 * A paid, convenient, untrusted backbone: encrypted store-and-forward, hosting
 * for the directory and revocation set, a durable archive clients read in
 * slices, and WebRTC signaling. Trusted for liveness only - it can delay,
 * withhold or disappear, and every one of those degrades the service without
 * weakening it.
 */

export {
  decode,
  encode,
  isPush,
  MAX_SLICE_SIZE,
  nextRequestId,
  RELAY_PROTOCOL_VERSION,
} from "./protocol"
export type {
  ClientMessage,
  HostedRecord,
  HostedSummary,
  RelayErrorCode,
  ServerMessage,
  ServerPush,
  ServerReply,
  SliceRequest,
  TurnCredentials,
} from "./protocol"

export { AUTH_VERSION, challengeBytes, newChallenge, signChallenge, verifyChallenge } from "./auth"

export type { Link, LinkState, WebSocketLinkOptions } from "./link"
export { LoopbackLink, WebSocketLink } from "./link"

export type { SocketLike } from "./socket-link"
export { SocketLink } from "./socket-link"

export type { RelayQuota } from "./server-store"
export { DEFAULT_QUOTA, RelayStore } from "./server-store"

export type { RelayMetrics, RelayServerOptions, RelayWriteHint, TurnIssuer } from "./server"
export { EphemeralTurnIssuer, RelayServer } from "./server"

export type { RelayClientOptions } from "./client"
export { RelayClient } from "./client"

export type { RelayConnectionOptions, RelayConnectionState } from "./connection"
export { RelayConnection } from "./connection"

export type { FailoverOptions, RankedTransport, TransportHealth } from "./failover"
export { FailoverTransport } from "./failover"

export type { ConnectionState, Route, StatusListener, SyncPhase, SyncStatus } from "./status"
export { derivePhase, initialStatus, SyncStatusTracker } from "./status"

export type { SignalHandler, SignalMessage } from "./signaling"
export { SignalingChannel } from "./signaling"
