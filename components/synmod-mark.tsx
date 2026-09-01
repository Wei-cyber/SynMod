type SynModMarkProps = {
  className?: string;
};

export function SynModMark({ className }: SynModMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M2.5 5.5 8 2.5l5.5 3L8 8.5l-5.5-3Z" />
      <path d="M2.5 5.5v5L8 13.5l5.5-3v-5M8 8.5v5" />
      <path d="M10.5 13.5 16 10.5l5.5 3-5.5 3-5.5-3Z" />
      <path d="M10.5 13.5v5l5.5 3 5.5-3v-5M16 16.5v5" />
      <path className="synmod-link" d="M8 13.5h2.5" />
      <circle className="synmod-joint" cx="9.25" cy="13.5" r="1.15" />
    </svg>
  );
}
