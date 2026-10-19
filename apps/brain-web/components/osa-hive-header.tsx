import type { ReactNode } from "react";

type View = "brain" | "bridge";

const external = { target: "_blank", rel: "noopener noreferrer" } as const;

export function OsaHiveHeader({
  view,
  connectionStatus,
}: {
  readonly view: View;
  readonly connectionStatus?: string;
}): ReactNode {
  return (
    <header className="topbar hive-header">
      <a href="/" className="hive-brand" aria-label="neurosa.ai — strona główna">
        <svg className="hive-mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <path d="M24 2.5 42.7 13.2v21.6L24 45.5 5.3 34.8V13.2Z" stroke="currentColor" strokeWidth="2.2"/>
          <path d="M14 33V15l10 15V15l10 18" stroke="currentColor" strokeWidth="3.2" strokeLinejoin="bevel"/>
          <circle cx="24" cy="2.5" r="2" fill="currentColor"/>
          <circle cx="42.7" cy="34.8" r="2" fill="currentColor"/>
          <circle cx="5.3" cy="34.8" r="2" fill="currentColor"/>
        </svg>
        <span className="hive-brand-name">neurosa<span>.ai</span><small>OSA HIVE / MEMORY ENGINE</small></span>
      </a>
      <nav className="hive-nav" aria-label="Nawigacja NeurOSA i ekosystemu">
        <a href="/" aria-current={view === "brain" ? "page" : undefined}>Mózg 3D</a>
        <a href="/memory/contextual-export" aria-current={view === "bridge" ? "page" : undefined}>Context Bridge</a>
        <a href="https://agentworlds.dev" {...external}>OSA Proof ↗</a>
        <a href="https://aether-eight-theta-52.vercel.app/" {...external}>Jeverson ↗</a>
        <a href="https://github.com/HazEOskA/osa-academy" {...external}>Academy ↗</a>
      </nav>
      <div className="hive-header-right">
        {connectionStatus && <span className={"connection " + connectionStatus}><span/>{connectionStatus}</span>}
        <a className="hive-github" href="https://github.com/HazEOskA/neurosa-human-brain" {...external} aria-label="Kod źródłowy NeurOSA na GitHub">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .8C5.82.8.8 5.82.8 12c0 4.95 3.21 9.15 7.66 10.64.56.11.77-.24.77-.54 0-.27-.01-1.14-.02-2.08-3.12.68-3.77-1.33-3.77-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.03-.71.08-.7.08-.7 1.14.08 1.75 1.17 1.75 1.17 1.01 1.74 2.66 1.24 3.31.95.1-.73.4-1.24.72-1.52-2.49-.28-5.1-1.25-5.1-5.55 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .94-.3 3.08 1.15A10.7 10.7 0 0 1 12 6.12c.95 0 1.91.13 2.81.38 2.14-1.45 3.08-1.15 3.08-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.31-2.62 5.27-5.12 5.54.4.35.77 1.04.77 2.1 0 1.52-.01 2.74-.01 3.11 0 .31.2.66.77.54A11.2 11.2 0 0 0 23.2 12C23.2 5.82 18.18.8 12 .8Z"/></svg>
          <span>GitHub ↗</span>
        </a>
      </div>
    </header>
  );
}
