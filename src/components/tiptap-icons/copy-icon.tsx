import * as React from "react";

export const CopyIcon = React.memo(
  ({ className, ...props }: React.SVGProps<SVGSVGElement>) => {
    return (
      <svg viewBox="0 0 24 24" 
      width={24} 
      height={24}
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
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <rect x="3" y="3" width="13" height="13" rx="2" />
    </svg>
    );
  }
);

CopyIcon.displayName = "CopyIcon";