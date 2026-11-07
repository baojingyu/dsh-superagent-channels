/** Endpoint paths and value types of the weixin sidecar's frozen HTTP contract; the backend SPI itself is `BridgeClient`. */

/** A person or account as the sidecar reports it: a stable platform ID and a display name that may change. */
export interface WxPerson { id: string; name: string }
/** A group the sidecar can listen to; `id` is the stable chatroom ID, never the display name. */
export interface WxRoom { id: string; name: string }

/** Paths of the frozen sidecar contract (sidecar/wxauto-bridge/contract.md §1). */
export const BridgeEndpoints = { health: '/health', status: '/status', rooms: '/rooms', members: '/members', messages: '/messages', send: '/send', listen: '/listen' } as const
