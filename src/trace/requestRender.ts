/**
 * Rendering requests without sending them.
 *
 * Inside `renderRequests`, every model request is built as usual and stops
 * where it would be sent: the request record hands the request to the
 * capture and throws `RequestNotSent`, before the provider is called, before
 * the token count, and on every protocol. Hooks do not run there either, so
 * rendering a turn runs no command the user configured.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestPurpose, RequestRecord } from "./requestTrace.js";

/** What one component of a rendered request carried: system prompt text, a tool's JSON, or message content. */
export interface RenderedContent {
  component: string;
  part: "system" | "tools" | "messages";
  text: string;
}

export interface RenderedRequest {
  purpose: RequestPurpose;
  /** The record the request would have had, without a result. */
  record: Omit<RequestRecord, "result">;
  /** The content of each component in request order; a component may appear more than once (messages). */
  contents: RenderedContent[];
}

export type RenderCapture = (request: RenderedRequest) => void;

/** Thrown where a request would go out while requests are rendered. Never retried. */
export class RequestNotSent extends Error {
  constructor() {
    super("The request was rendered and not sent.");
    this.name = "RequestNotSent";
  }
}

const frames = new AsyncLocalStorage<RenderCapture>();

/** Run `fn` with every model request it makes rendered into `capture` instead of sent. */
export function renderRequests<T>(capture: RenderCapture, fn: () => T): T {
  return frames.run(capture, fn);
}

/** The capture of the current work, when its requests are rendered rather than sent. */
export function renderCapture(): RenderCapture | undefined {
  return frames.getStore();
}

/** Whether the current work renders requests rather than sending them. */
export function renderingRequests(): boolean {
  return frames.getStore() !== undefined;
}
