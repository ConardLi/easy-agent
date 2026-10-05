/**
 * Provider and model logos from LobeHub's icon set (`@lobehub/icons-static-svg`,
 * MIT). Colored variants are used where they exist; monochrome ones draw with
 * `currentColor` so they follow the theme.
 */

import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg?raw";
import claude from "@lobehub/icons-static-svg/icons/claude-color.svg?raw";
import openai from "@lobehub/icons-static-svg/icons/openai.svg?raw";
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg?raw";
import google from "@lobehub/icons-static-svg/icons/google-color.svg?raw";
import gemma from "@lobehub/icons-static-svg/icons/gemma-color.svg?raw";
import vertexai from "@lobehub/icons-static-svg/icons/vertexai-color.svg?raw";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg?raw";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg?raw";
import bailian from "@lobehub/icons-static-svg/icons/bailian-color.svg?raw";
import moonshot from "@lobehub/icons-static-svg/icons/moonshot.svg?raw";
import kimi from "@lobehub/icons-static-svg/icons/kimi.svg?raw";
import zhipu from "@lobehub/icons-static-svg/icons/zhipu-color.svg?raw";
import chatglm from "@lobehub/icons-static-svg/icons/chatglm-color.svg?raw";
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg?raw";
import doubao from "@lobehub/icons-static-svg/icons/doubao-color.svg?raw";
import volcengine from "@lobehub/icons-static-svg/icons/volcengine-color.svg?raw";
import siliconcloud from "@lobehub/icons-static-svg/icons/siliconcloud-color.svg?raw";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter-color.svg?raw";
import xai from "@lobehub/icons-static-svg/icons/xai.svg?raw";
import grok from "@lobehub/icons-static-svg/icons/grok.svg?raw";
import mistral from "@lobehub/icons-static-svg/icons/mistral-color.svg?raw";
import groq from "@lobehub/icons-static-svg/icons/groq.svg?raw";
import azure from "@lobehub/icons-static-svg/icons/azure-color.svg?raw";
import bedrock from "@lobehub/icons-static-svg/icons/bedrock-color.svg?raw";
import ollama from "@lobehub/icons-static-svg/icons/ollama.svg?raw";
import lmstudio from "@lobehub/icons-static-svg/icons/lmstudio.svg?raw";
import vllm from "@lobehub/icons-static-svg/icons/vllm-color.svg?raw";
import together from "@lobehub/icons-static-svg/icons/together-color.svg?raw";
import fireworks from "@lobehub/icons-static-svg/icons/fireworks-color.svg?raw";
import perplexity from "@lobehub/icons-static-svg/icons/perplexity-color.svg?raw";
import cerebras from "@lobehub/icons-static-svg/icons/cerebras-color.svg?raw";
import nvidia from "@lobehub/icons-static-svg/icons/nvidia-color.svg?raw";
import meta from "@lobehub/icons-static-svg/icons/meta-color.svg?raw";
import hunyuan from "@lobehub/icons-static-svg/icons/hunyuan-color.svg?raw";
import stepfun from "@lobehub/icons-static-svg/icons/stepfun-color.svg?raw";
import wenxin from "@lobehub/icons-static-svg/icons/wenxin-color.svg?raw";
import aihubmix from "@lobehub/icons-static-svg/icons/aihubmix-color.svg?raw";
import newapi from "@lobehub/icons-static-svg/icons/newapi-color.svg?raw";
import ppio from "@lobehub/icons-static-svg/icons/ppio-color.svg?raw";
import modelscope from "@lobehub/icons-static-svg/icons/modelscope-color.svg?raw";
import github from "@lobehub/icons-static-svg/icons/github.svg?raw";
import codex from "@lobehub/icons-static-svg/icons/codex-color.svg?raw";
import huggingface from "@lobehub/icons-static-svg/icons/huggingface-color.svg?raw";
import deepinfra from "@lobehub/icons-static-svg/icons/deepinfra-color.svg?raw";
import longcat from "@lobehub/icons-static-svg/icons/longcat-color.svg?raw";
import xiaomimimo from "@lobehub/icons-static-svg/icons/xiaomimimo.svg?raw";
import { cn } from "./primitives";

const ICONS = {
  anthropic: { svg: anthropic, mono: true },
  claude: { svg: claude, mono: false },
  openai: { svg: openai, mono: true },
  gemini: { svg: gemini, mono: false },
  google: { svg: google, mono: false },
  gemma: { svg: gemma, mono: false },
  vertexai: { svg: vertexai, mono: false },
  deepseek: { svg: deepseek, mono: false },
  qwen: { svg: qwen, mono: false },
  bailian: { svg: bailian, mono: false },
  moonshot: { svg: moonshot, mono: true },
  kimi: { svg: kimi, mono: true },
  zhipu: { svg: zhipu, mono: false },
  chatglm: { svg: chatglm, mono: false },
  minimax: { svg: minimax, mono: false },
  doubao: { svg: doubao, mono: false },
  volcengine: { svg: volcengine, mono: false },
  siliconcloud: { svg: siliconcloud, mono: false },
  openrouter: { svg: openrouter, mono: false },
  xai: { svg: xai, mono: true },
  grok: { svg: grok, mono: true },
  mistral: { svg: mistral, mono: false },
  groq: { svg: groq, mono: true },
  azure: { svg: azure, mono: false },
  bedrock: { svg: bedrock, mono: false },
  ollama: { svg: ollama, mono: true },
  lmstudio: { svg: lmstudio, mono: true },
  vllm: { svg: vllm, mono: false },
  together: { svg: together, mono: false },
  fireworks: { svg: fireworks, mono: false },
  perplexity: { svg: perplexity, mono: false },
  cerebras: { svg: cerebras, mono: false },
  nvidia: { svg: nvidia, mono: false },
  meta: { svg: meta, mono: false },
  hunyuan: { svg: hunyuan, mono: false },
  stepfun: { svg: stepfun, mono: false },
  wenxin: { svg: wenxin, mono: false },
  aihubmix: { svg: aihubmix, mono: false },
  newapi: { svg: newapi, mono: false },
  ppio: { svg: ppio, mono: false },
  modelscope: { svg: modelscope, mono: false },
  github: { svg: github, mono: true },
  codex: { svg: codex, mono: false },
  huggingface: { svg: huggingface, mono: false },
  deepinfra: { svg: deepinfra, mono: false },
  longcat: { svg: longcat, mono: false },
  xiaomimimo: { svg: xiaomimimo, mono: true },
} as const;

export type BrandId = keyof typeof ICONS;

/** Model id → logo of the model family, independent of who serves it. */
const MODEL_FAMILIES: [RegExp, BrandId][] = [
  [/claude/i, "claude"],
  [/codex/i, "codex"],
  [/^(gpt|o\d|chatgpt|text-embedding)/i, "openai"],
  [/gemini/i, "gemini"],
  [/gemma/i, "gemma"],
  [/deepseek/i, "deepseek"],
  [/qwen|qwq/i, "qwen"],
  [/kimi|moonshot/i, "kimi"],
  [/glm|chatglm/i, "chatglm"],
  [/minimax|abab/i, "minimax"],
  [/doubao|seed/i, "doubao"],
  [/grok/i, "grok"],
  [/mistral|codestral|devstral|magistral/i, "mistral"],
  [/llama/i, "meta"],
  [/hunyuan/i, "hunyuan"],
  [/step/i, "stepfun"],
  [/ernie|wenxin/i, "wenxin"],
  [/longcat/i, "longcat"],
  [/mimo/i, "xiaomimimo"],
  [/nemotron/i, "nvidia"],
];

export function modelBrand(modelId: string): BrandId | null {
  return MODEL_FAMILIES.find(([re]) => re.test(modelId))?.[1] ?? null;
}

export function BrandIcon({ id, size = 16, className, tile }: { id: BrandId | string | null | undefined; size?: number; className?: string; tile?: boolean }) {
  const icon = id && id in ICONS ? ICONS[id as BrandId] : null;
  const glyph = icon ? (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full", icon.mono && "text-fg", !tile && className)}
      style={{ width: tile ? size * 0.62 : size, height: tile ? size * 0.62 : size }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: bundled SVG assets
      dangerouslySetInnerHTML={{ __html: icon.svg }}
    />
  ) : (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-[4px] bg-surface-3 font-semibold text-fg-2", !tile && className)}
      style={{ width: tile ? size * 0.62 : size, height: tile ? size * 0.62 : size, fontSize: size * (tile ? 0.36 : 0.56) }}
    >
      {String(id ?? "?")
        .slice(0, 1)
        .toUpperCase()}
    </span>
  );
  if (!tile) return glyph;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[28%] border border-line bg-canvas shadow-[0_1px_2px_rgb(0_0_0/0.06)]",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {glyph}
    </span>
  );
}
