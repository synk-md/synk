import * as React from "react";

export const FormatIcon = React.memo(
  ({ className, ...props }: React.SVGProps<SVGSVGElement>) => {
    return (
     <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M4 6h16" />
      <path d="M12 6v12" />
      <path d="M8 18h8" />
    </svg>
    );
  }
);

FormatIcon.displayName = "FormatIcon"