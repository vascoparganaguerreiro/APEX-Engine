export default function ReadinessRing({ score, color, label = "READINESS" }: { score: number; color: string; label?: string }) {
  const circ = 477.5; // 2 * PI * 76
  const offset = circ * (1 - Math.max(0, Math.min(100, score)) / 100);
  return (
    <div className="ring" role="img" aria-label={`${label === "READINESS" ? "Readiness" : "Last readiness reading"} ${score} out of 100`}>
      <svg width="190" height="190" viewBox="0 0 180 180" style={{ transform: "rotate(-90deg)" }}>
        <defs>
          <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2ee6a6" />
            <stop offset="1" stopColor="#4da3ff" />
          </linearGradient>
        </defs>
        <circle cx="90" cy="90" r="76" fill="none" stroke="var(--line)" strokeWidth="12" />
        <circle cx="90" cy="90" r="76" fill="none" stroke={label === "READINESS" ? "url(#ring-grad)" : "var(--muted)"} strokeWidth="12"
          strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={offset} />
      </svg>
      <div className="ring-center">
        <b style={{ color }}>{score}</b>
        <small>{label}</small>
      </div>
    </div>
  );
}
