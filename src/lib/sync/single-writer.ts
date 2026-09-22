/**
 * Single-writer guard for a stable client id.
 *
 * Two tabs share an IndexedDB, hence the same device key and the same derived
 * client id. Without coordination both can author under it and collide in
 * `(client, clock)` space - silent, unrecoverable corruption that the clock
 * watermark can detect afterwards but cannot prevent.
 *
 * Web Locks is the mechanism: a lock held for the lifetime of the tab, released
 * automatically when the tab dies, so a crashed leader does not strand the
 * others. The backend is injectable because `navigator.locks` is absent in
 * jsdom and in non-secure contexts, and because a caller may want to supply a
 * leader election of its own.
 *
 * When no backend is available this reports `unavailable` rather than silently
 * claiming leadership - the caller decides whether to proceed unguarded.
 */

export type WriterStatus = "leader" | "follower" | "unavailable"

export interface LockBackend {
  /**
   * Acquire `name` exclusively and hold it until the returned release is
   * called. Resolves with null if the lock is already held elsewhere.
   */
  acquire(name: string): Promise<(() => void) | null>
}

interface LockManagerLike {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void>
}

/** Web Locks, when the platform has it. */
export function webLockBackend(): LockBackend | undefined {
  const locks = (globalThis.navigator as unknown as { locks?: LockManagerLike } | undefined)?.locks
  if (!locks) return undefined

  return {
    acquire(name) {
      return new Promise<(() => void) | null>((resolve) => {
        let settled = false
        void locks
          .request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
            if (!lock) {
              if (!settled) {
                settled = true
                resolve(null)
              }
              return
            }
            // Hold the lock until release() is called by resolving the callback
            // only then; Web Locks frees it when this promise settles.
            await new Promise<void>((release) => {
              settled = true
              resolve(() => release())
            })
          })
          .catch(() => {
            if (!settled) {
              settled = true
              resolve(null)
            }
          })
      })
    },
  }
}

export interface SingleWriterOptions {
  /** Distinct per device and document, so unrelated documents do not contend. */
  name: string
  backend?: LockBackend
}

export class SingleWriterGuard {
  readonly name: string
  private readonly backend: LockBackend | undefined
  private release: (() => void) | null = null
  private current: WriterStatus = "unavailable"

  constructor(options: SingleWriterOptions) {
    this.name = options.name
    this.backend = options.backend ?? webLockBackend()
  }

  get status(): WriterStatus {
    return this.current
  }

  /** True only when this context holds the lock. */
  get isLeader(): boolean {
    return this.current === "leader"
  }

  async claim(): Promise<WriterStatus> {
    if (!this.backend) {
      this.current = "unavailable"
      return this.current
    }
    if (this.release) return this.current

    const release = await this.backend.acquire(this.name)
    this.release = release
    this.current = release ? "leader" : "follower"
    return this.current
  }

  /** Give up leadership. Another context may then claim it. */
  yield(): void {
    this.release?.()
    this.release = null
    if (this.current === "leader") this.current = "follower"
  }
}

/** Lock name for one device writing one document. */
export function writerLockName(deviceDid: string, resourceId: string): string {
  return `synk/writer/${deviceDid}/${resourceId}`
}
