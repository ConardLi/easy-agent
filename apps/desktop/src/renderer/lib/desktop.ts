import type { DesktopApi } from "../../shared/contract";

/** The API the preload script exposes; the renderer has no other way into the main process. */
export const desktop: DesktopApi = window.easyAgent;
