/**
 * Pending interaction requests (permission, plan approval, question).
 *
 * The agentic loop awaits a promise for each request; the broker decides who
 * answers it:
 *   1. a handler registered for the kind answers automatically;
 *   2. otherwise, when the frontend declared it handles the kind, the request
 *      is published and stays pending until `respond()`, an interrupt, the
 *      end of the turn, or the session closing settles it;
 *   3. otherwise the safe default applies immediately.
 *
 * A request settled by anything but a response gets the same answer as a
 * dismissed prompt: permission and plan approval are denied, questions are
 * cancelled.
 */

import { randomUUID } from "node:crypto";
import type {
  InteractionHandlers,
  InteractionKind,
  InteractionRequest,
  InteractionResolution,
  InteractionResponse,
  PermissionResponse,
  PlanApprovalResponse,
  QuestionResponse,
  RespondOutcome,
} from "../types.js";

type ResponseFor<K extends InteractionKind> = K extends "permission"
  ? PermissionResponse
  : K extends "plan_approval"
    ? PlanApprovalResponse
    : QuestionResponse;

type RequestFor<K extends InteractionKind> = Extract<InteractionRequest, { kind: K }>;

/** Request content before the broker assigns its id. */
export type InteractionDraft<K extends InteractionKind> = Omit<RequestFor<K>, "id">;

interface Pending {
  request: InteractionRequest;
  settle: (response: InteractionResponse, resolution: InteractionResolution) => void;
}

export interface InteractionBrokerHooks {
  opened(request: InteractionRequest): void;
  resolved(request: InteractionRequest, resolution: InteractionResolution): void;
}

const DISMISSED: { [K in InteractionKind]: ResponseFor<K> } = {
  permission: { decision: "deny" },
  plan_approval: { decision: "reject" },
  question: { cancelled: true },
};

export class InteractionBroker {
  readonly #pending = new Map<string, Pending>();

  constructor(
    private readonly frontendKinds: ReadonlySet<InteractionKind>,
    private readonly handlers: InteractionHandlers,
    private readonly hooks: InteractionBrokerHooks,
  ) {}

  /** Kinds that reach a human (frontend or handler) instead of the safe default. */
  isAnswered(kind: InteractionKind): boolean {
    return this.handlers[kind] !== undefined || this.frontendKinds.has(kind);
  }

  async request<K extends InteractionKind>(draft: InteractionDraft<K>): Promise<ResponseFor<K>> {
    const request = { ...draft, id: randomUUID() } as unknown as RequestFor<K>;
    const handler = this.handlers[request.kind] as
      | ((r: RequestFor<K>) => ResponseFor<K> | Promise<ResponseFor<K>>)
      | undefined;
    if (handler) {
      this.hooks.opened(request);
      try {
        return await handler(request);
      } finally {
        this.hooks.resolved(request, "handler");
      }
    }
    if (!this.frontendKinds.has(request.kind)) {
      return DISMISSED[request.kind] as ResponseFor<K>;
    }
    return new Promise<ResponseFor<K>>((resolve) => {
      this.#pending.set(request.id, {
        request,
        settle: (response, resolution) => {
          this.#pending.delete(request.id);
          resolve(response as ResponseFor<K>);
          this.hooks.resolved(request, resolution);
        },
      });
      this.hooks.opened(request);
    });
  }

  respond(requestId: string, response: InteractionResponse): RespondOutcome {
    const pending = this.#pending.get(requestId);
    if (!pending) return "stale";
    assertResponseMatches(pending.request.kind, response);
    pending.settle(response, "response");
    return "resolved";
  }

  list(): InteractionRequest[] {
    return [...this.#pending.values()].map((pending) => pending.request);
  }

  /** The oldest pending request of one of `kinds`, if any. */
  find(kinds: readonly InteractionKind[]): InteractionRequest | undefined {
    return this.list().find((request) => kinds.includes(request.kind));
  }

  /** Settle one request with its dismissed answer. */
  dismiss(requestId: string, resolution: InteractionResolution): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    pending.settle(DISMISSED[pending.request.kind], resolution);
    return true;
  }

  dismissAll(resolution: InteractionResolution): void {
    for (const id of [...this.#pending.keys()]) this.dismiss(id, resolution);
  }
}

function assertResponseMatches(kind: InteractionKind, response: InteractionResponse): void {
  const ok =
    kind === "question"
      ? "answers" in response || "cancelled" in response
      : kind === "permission"
        ? "decision" in response && ["allow_once", "allow_always", "deny"].includes(response.decision)
        : "decision" in response && (response.decision === "approve" || response.decision === "reject");
  if (!ok) throw new TypeError(`Response does not answer a ${kind} request.`);
}
