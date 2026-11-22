import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { ConfigurationError } from "../../../config/values.js";
import type { ModelProfile } from "./profile.js";

/** Explicit capability restrictions apply to generation and auxiliary requests alike. */
export function validateDeclaredCapabilities(
  profile: ModelProfile,
  params: { tools?: readonly object[]; messages: readonly MessageParam[] },
): void {
  if (profile.capabilities?.tools === false && params.tools?.length)
    throw new ConfigurationError(
      `models.${profile.id}.capabilities.tools`,
      "this profile disables tool calls; select a capable profile or remove tools for this request.",
    );
  if (profile.capabilities?.vision === false) {
    const image = params.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            block.type === "image" ||
            (block.type === "tool_result" &&
              Array.isArray(block.content) &&
              block.content.some((part) => part.type === "image")),
        ),
    );
    if (image)
      throw new ConfigurationError(
        `models.${profile.id}.capabilities.vision`,
        "this profile disables images; select a capable profile or remove the image.",
      );
  }
}
