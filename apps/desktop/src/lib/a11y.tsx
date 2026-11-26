import React, { useEffect, useRef } from "react";

/**
 * Keyboard movement for a `role="tablist"` (WAI-ARIA APG tabs pattern, with
 * automatic activation): Left/Right step and wrap, Home/End jump to the ends.
 * The newly selected tab also takes focus, so the roving `tabIndex` and the
 * focus stay on the same element.
 *
 * Returns true when it handled the key, so callers can layer their own keys
 * (Delete to close an editor tab) without both firing.
 */
export function tabKeyDown(
  e: React.KeyboardEvent<HTMLElement>,
  index: number,
  count: number,
  select: (i: number) => void
): boolean {
  let next: number;
  switch (e.key) {
    case "ArrowRight":
      next = (index + 1) % count;
      break;
    case "ArrowLeft":
      next = (index - 1 + count) % count;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = count - 1;
      break;
    default:
      return false;
  }
  e.preventDefault();
  select(next);
  const list = e.currentTarget.closest('[role="tablist"]');
  list?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  return true;
}

/** Props that make an element one tab of a tablist. */
export function tabProps(id: string, panelId: string, selected: boolean) {
  return {
    role: "tab" as const,
    id,
    "aria-selected": selected,
    "aria-controls": panelId,
    // Roving tabindex: Tab enters the list on the selected tab, the arrows
    // move within it, and the next Tab leaves for the panel.
    tabIndex: selected ? 0 : -1,
  };
}

/** The panel a `TabList` controls. Only the selected tab's content is ever
 *  rendered, so one panel id serves the whole strip. */
export function tabPanelProps(idBase: string, active: string) {
  return {
    role: "tabpanel" as const,
    id: `${idBase}-panel`,
    "aria-labelledby": `${idBase}-tab-${active}`,
  };
}

/**
 * A strip of `.rtab` tabs. The app had five of these, each a row of bare
 * buttons a screen reader could not tell apart from a toolbar, none saying
 * which was selected.
 */
export function TabList<T extends string>(p: {
  label: string;
  idBase: string;
  tabs: readonly (readonly [T, React.ReactNode])[];
  active: T;
  onSelect: (t: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={p.label} className={p.className}>
      {p.tabs.map(([id, label], i) => (
        <button
          key={id}
          {...tabProps(`${p.idBase}-tab-${id}`, `${p.idBase}-panel`, p.active === id)}
          className={`rtab ${p.active === id ? "on" : ""}`}
          onClick={() => p.onSelect(id)}
          onKeyDown={(e) => tabKeyDown(e, i, p.tabs.length, (n) => p.onSelect(p.tabs[n][0]))}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const ITEMS ='[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/**
 * A dropdown `role="menu"`.
 *
 * On open it moves focus to the first item; Up/Down/Home/End move between
 * items; Escape closes it and hands focus back to whatever opened it. Focus
 * also goes back to the opener when the menu closes some other way (an item
 * was picked, the trigger was clicked again) — unless it has already gone
 * somewhere on purpose, such as into a dialog the item opened.
 */
export function Menu(p: {
  label: string;
  className: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.querySelector<HTMLElement>(ITEMS)?.focus();
    return () => {
      const at = document.activeElement;
      if (!at || at === document.body || node?.contains(at)) opener?.focus?.();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // Stop here: inside a modal, Escape should close the menu, not the modal.
      e.stopPropagation();
      p.onClose();
      return;
    }
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEMS)].filter(
      (el) => !(el as HTMLButtonElement).disabled
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === "ArrowDown") next = (at + 1) % items.length;
    else if (e.key === "ArrowUp") next = at <= 0 ? items.length - 1 : at - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    items[next].focus();
  };

  return (
    <div ref={ref} role="menu" aria-label={p.label} className={p.className} onKeyDown={onKeyDown}>
      {p.children}
    </div>
  );
}

/** A labelled section of a `Menu`: the visible caption names the group. */
export function MenuGroup(p: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-labelledby={p.id}>
      <div className="menu-label" id={p.id}>
        {p.label}
      </div>
      {p.children}
    </div>
  );
}
