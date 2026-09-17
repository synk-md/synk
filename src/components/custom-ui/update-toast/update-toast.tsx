import { RiRefreshLine } from "@remixicon/react"
import "./update-toast.scss"

export interface UpdateToastProps {
  onReload: () => void
}

export function UpdateToast({ onReload }: UpdateToastProps) {
  return (
    <div className="update-toast" role="status">
      <span>A new version of Synk is available.</span>
      <button className="update-toast__reload" onClick={onReload}>
        <RiRefreshLine />
        Reload
      </button>
    </div>
  )
}

export default UpdateToast
