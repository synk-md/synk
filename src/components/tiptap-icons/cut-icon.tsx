import * as React from "react";

export const CutIcon = React.memo(
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
        <circle cx="6" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M20 4L8.5 15.5" />
        <path d="M20 20L8.5 8.5" />
      </svg>
    );
  }
);

CutIcon.displayName = "CutIcon";