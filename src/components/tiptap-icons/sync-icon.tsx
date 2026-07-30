import * as React from "react"

export const SyncIcon = React.memo(
  ({ className, ...props }: React.SVGProps<SVGSVGElement>) => {
    return (
      <svg
        width="24"
        height="24"
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        xmlns="http://www.w3.org/2000/svg"
        {...props}
      >
        <polyline points="23 4 23 10 17 10" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <polyline points="1 20 1 14 7 14" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3.51 9a9 9 0 0114.13-3.36L23 10" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M1 14l5.36 4.36A9 9 0 0020.49 15" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
)

SyncIcon.displayName = "SyncIcon"