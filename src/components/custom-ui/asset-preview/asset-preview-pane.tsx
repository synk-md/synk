import * as React from "react"
import { RiFileDamageLine } from "@remixicon/react"
import { CloseIcon } from "@/components/tiptap-icons/close-icon"
import { Button } from "@/components/tiptap-ui-primitive/button"
import "./asset-preview-pane.scss"

export type AssetPreviewPaneProps = {
  assetId: string
  name: string
  resolveAsset: (assetId: string) => Promise<Blob | null>
  onClose: () => void
}

export function AssetPreviewPane({ assetId, name, resolveAsset, onClose }: AssetPreviewPaneProps) {
  const [src, setSrc] = React.useState<string | null>(null)
  const [unavailable, setUnavailable] = React.useState(false)

  React.useEffect(() => {
    let disposed = false
    let objectUrl: string | null = null

    setSrc(null)
    setUnavailable(false)

    void resolveAsset(assetId)
      .then((blob) => {
        if (disposed) return
        if (!blob) {
          setUnavailable(true)
          return
        }
        objectUrl = URL.createObjectURL(blob)
        setSrc(objectUrl)
      })
      .catch((error) => {
        if (!disposed) {
          console.error(`Failed to resolve image asset ${assetId}:`, error)
          setUnavailable(true)
        }
      })

    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [assetId, resolveAsset])

  return (
    <div className="asset-preview-pane">
      <div className="asset-preview-header">
        <span className="asset-preview-name">{name}</span>
        <Button data-style="ghost" aria-label="Close preview" onClick={onClose}>
          <CloseIcon className="tiptap-button-icon" />
        </Button>
      </div>
      <div className="asset-preview-body">
        {src ? (
          <img src={src} alt={name} draggable={false} />
        ) : unavailable ? (
          <div className="asset-preview-placeholder asset-preview-placeholder--broken">
            <RiFileDamageLine />
            <span>Image unavailable</span>
          </div>
        ) : (
          <div className="asset-preview-placeholder">Loading image…</div>
        )}
      </div>
    </div>
  )
}
