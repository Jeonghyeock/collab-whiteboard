export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" style={{ fill: 'var(--accent)' }} />
      <path d="M8 20c3-7 6-9 8-5s5 3 8-5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="24" cy="22" r="2.4" fill="#fff" />
    </svg>
  );
}
