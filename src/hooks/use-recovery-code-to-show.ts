"use client"

import * as React from "react"

import { onRecoveryCodes, recoveryCodeToShow } from "@/lib/workspace"

/** A notebook's new recovery code, while it still waits to be shown. */
export function useRecoveryCodeToShow(notebookId: string | null): string | null {
  return React.useSyncExternalStore(
    onRecoveryCodes,
    () => (notebookId ? recoveryCodeToShow(notebookId) : null),
    () => null,
  )
}
