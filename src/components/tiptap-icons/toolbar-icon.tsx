import * as React from "react";

export const ToolbarIcon = React.memo(
  ({ className, size = 14, ...props }: React.SVGProps<SVGSVGElement> & { size?: number | string }) => (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <rect x="3" y="4" width="18" height="4" rx="1" fill="currentColor" stroke="none" />
    </svg>
  )
);

ToolbarIcon.displayName = "ToolbarIcon";