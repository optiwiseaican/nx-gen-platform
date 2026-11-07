/** Line icons for navigation (24 px grid, 1.8 stroke). Decorative: always paired with text. */
const P = {
  home: "M3.5 10.5 12 4l8.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-5v6H5A1.5 1.5 0 0 1 3.5 19z",
  tasks: "M9 6.5h11M9 12h11M9 17.5h11M4 6.5l1 1 2-2M4 12l1 1 2-2M4 17.5l1 1 2-2",
  instrument: "M4.5 17.5a8.5 8.5 0 1 1 15 0M12 13.5l3.5-4M12 15a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M7 9.5l1 1M12 6.5V8M17 9.5l-1 1",
  method: "M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7.5 3.5M13.5 3.5V8h4.5M9 12.5h6M9 16h6",
  users: "M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M20 20v-1.5a3.5 3.5 0 0 0-2.5-3.35M15 4.65a3.5 3.5 0 0 1 0 6.7",
  roles: "M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6zM9 12l2 2 4-4",
  audit: "M5 4.5h14M5 9.5h14M5 14.5h9M5 19.5h6M17.5 16.5l1.5 1.5 3-3",
  security: "M6.5 10.5V8a5.5 5.5 0 0 1 11 0v2.5M5.5 10.5h13a1 1 0 0 1 1 1V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19v-7.5a1 1 0 0 1 1-1M12 14.5v2.5",
  modules: "M4 4.5h7v7H4zM13 4.5h7v7h-7zM4 13.5h7v7H4zM16.5 13.5v7M13 17h7",
  system: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 11v5.5M12 7.6v.4",
  module: "M9 3.5h6M10 3.5v6L5.5 17a2.3 2.3 0 0 0 2 3.5h9a2.3 2.3 0 0 0 2-3.5L14 9.5v-6M8.5 14h7",
  signout: "M15 4.5h3.5A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5H15M10 16.5 14.5 12 10 7.5M14.5 12H4",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6 6 18",
  connections: "M5 12.5a10 10 0 0 1 14 0M8 15.5a5.5 5.5 0 0 1 8 0M12 19h.01M2 9.5a14.5 14.5 0 0 1 20 0",
} as const;

export type IconName = keyof typeof P;

export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={P[name]} />
    </svg>
  );
}

/** The NxGen app tile: a rounded blue square with a stylised flask-and-check mark. */
export function LogoTile({ size = "h-11 w-11" }: { size?: string }) {
  return (
    <span
      className={`${size} inline-grid shrink-0 place-items-center rounded-[30%] bg-gradient-to-br from-[#3b82f6] via-brand to-[#1e40af] text-white shadow-[var(--shadow-brand)]`}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="h-[58%] w-[58%]" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.5 3.5h5M10.5 3.5v5.5L6 17a2.2 2.2 0 0 0 1.9 3.3h8.2A2.2 2.2 0 0 0 18 17l-4.5-8V3.5" />
        <path d="m9.5 15 1.8 1.8 3.3-3.3" />
      </svg>
    </span>
  );
}
