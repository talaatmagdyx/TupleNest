import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

/** Emitted by pg.rs (`CONNECTION_LOST_EVENT`) when the live session's
 *  connection ends without the app asking: a terminated backend, a server
 *  restart, a network that went away. */
export const CONNECTION_LOST_EVENT = "pg:connection-lost";

export type ConnectionLostPayload = {
  /** `pg_connect`'s generation for the session that ended. */
  generation: number;
  /** "Connection lost: …", the same first line a failed statement returns. */
  message: string;
  sqlstate: string | null;
};

/** What the Connection lost dialog says. A transaction open at the time is
 *  gone — the server rolls it back when the backend ends — and someone who
 *  was halfway through one needs to hear that, not just "reconnect". */
export function lostDetail(message: string, inTransaction: boolean): string {
  if (!inTransaction) return message;
  return `${message} The open transaction was rolled back by the server: nothing in it was committed.`;
}

/**
 * Hears about a lost connection the moment the backend does, instead of on
 * the next statement. Nothing polls: the backend's connection task is already
 * reading the socket.
 *
 * `isLive` decides whether the event is about the session on screen — after a
 * disconnect or a reconnect it is not, and a dialog then would report the loss
 * of something the user closed on purpose.
 */
export function useConnectionLost(
  isLive: (generation: number) => boolean,
  onLost: (message: string) => void,
): void {
  // Refs, so the listener is registered once and still calls the latest
  // handlers: re-subscribing on every render could miss an event in between.
  const live = useRef(isLive);
  const lost = useRef(onLost);
  useEffect(() => {
    live.current = isLive;
    lost.current = onLost;
  }, [isLive, onLost]);
  useEffect(() => {
    const stop = listen<ConnectionLostPayload>(CONNECTION_LOST_EVENT, (e) => {
      if (live.current(e.payload.generation)) lost.current(e.payload.message);
    });
    return () => {
      void stop.then((off) => off());
    };
  }, []);
}
