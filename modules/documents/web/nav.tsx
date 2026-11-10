import Link from "next/link";
import type { ReactNode } from "react";

export type Section = "documents" | "templates" | "profile";

const SECTIONS: { id: Section; label: string; href: string }[] = [
  { id: "documents", label: "Documents", href: "/documents" },
  { id: "templates", label: "Templates", href: "/documents/templates" },
  { id: "profile", label: "Profile", href: "/documents/settings" },
];

/** Page bar shared by every page of the module: title and description on the left, the module's sections on the right. */
export function PageBar({ title, description, current, actions }: { title: string; description?: ReactNode; current: Section; actions?: ReactNode }) {
  return (
    <>
    <header className="dc-bar">
      <div className="dc-bar-text">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <nav className="dc-bar-tools" aria-label="Documents sections">
        <div className="seg">
          {SECTIONS.map((section) => (
            <Link key={section.id} href={section.href} aria-current={section.id === current ? "page" : undefined}>
              {section.label}
            </Link>
          ))}
        </div>
        {actions}
      </nav>
    </header>
    </>
  );
}
