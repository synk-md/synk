import { useState } from "react"
import { RiRefreshLine } from "@remixicon/react"
import "./update-toast.scss"

export interface UpdateToastProps {
  /** May be async - pending writes are flushed before the reload (see main.tsx). */
  onReload: () => void | Promise<void>
}

export function UpdateToast({ onReload }: UpdateToastProps) {
  const [reloading, setReloading] = useState(false)

  const handleReload = () => {
    // The flush is asynchronous and the tab only reloads once it finishes, so
    // without this a second click would start a second handover.
    if (reloading) return
    setReloading(true)

    void Promise.resolve(onReload()).catch((error) => {
      console.error("Could not reload to the new version", error)
      setReloading(false)
    })
  }

  return (
    <div className="update-toast" role="status">
      <span>A new version of Synk is available.</span>
      <button className="update-toast__reload" onClick={handleReload} disabled={reloading}>
        <RiRefreshLine />
        {reloading ? "Reloading…" : "Reload"}
      </button>
    </div>
  )
}

export default UpdateToast
