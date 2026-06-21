import Anthropic from "@anthropic-ai/sdk";
import * as Sentry from "@sentry/nextjs";
import type { PhysicalObject } from "@/types/topo";
import { buildPriorStatePrompt, type PriorStatePrompt } from "@/utils/statePrompt";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const systemPrompt = `You are the perception layer of a physical-world state tracker.
You will see a photo (possibly just a cropped sub-region of a larger scene) and the
prior known state of objects in that scene. Your job:
1. Identify every object visible in the image.
2. For each, decide: is this the SAME object as one in the prior state (same id, even
   if it moved or rotated — use your judgment about what's physically plausible), is it
   NEW, or is a prior object now MISSING from view?
3. Estimate grid position x,y (0-10) and a rough relative depth z (0-10, 0=closest to
   camera) for each object.
4. Briefly state your reasoning for any non-obvious identity match or mismatch.
Respond ONLY with valid JSON matching this shape, no prose outside the JSON:
{ "objects": [{ "id": string, "label": string, "x": number, "y": number, "z": number,
"status": "idle"|"active"|"misplaced"|"hazard", "confidence": number }],
"reasoning": string }`;

interface ReconcileResult {
  objects: PhysicalObject[];
  reasoning: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  /** State-delta accounting for the prior-state prompt we actually sent. */
  statePrompt: PriorStatePrompt;
}

function extractJson(text: string): { objects: PhysicalObject[]; reasoning: string } {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const payload = fenced?.[1]?.trim() ?? trimmed;
  const parsed = JSON.parse(payload) as {
    objects: PhysicalObject[];
    reasoning: string;
  };
  return parsed;
}

export async function reconcileCommit(
  croppedImageBase64: string,
  priorObjects: PhysicalObject[],
  bbox: { x0: number; y0: number; x1: number; y1: number } | null,
  imageWidth = 0,
  imageHeight = 0,
  spatialMemory = "",
): Promise<ReconcileResult> {
  const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;

  // Layer 2: deterministic state-delta — only the changed region is detailed,
  // out-of-view object coordinates are deleted (provably unchanged).
  const statePrompt = buildPriorStatePrompt(
    priorObjects,
    bbox,
    imageWidth,
    imageHeight,
  );

  const memoryBlock = spatialMemory ? `\n${spatialMemory}\n` : "";

  const userText = bbox
    ? `This image is a CROPPED REGION of the full scene (only the area that changed
       since the last commit, sent to save tokens). Region bounds in original frame:
       ${JSON.stringify(bbox)}.
       ${statePrompt.prompt}${memoryBlock}
       Report ONLY objects visible in THIS crop (updated positions for "changed-region"
       ids, plus any genuinely new objects). The "keep-unchanged" ids are handled
       outside this call — do NOT output them and do NOT invent coordinates for them.
       Use SPATIAL MEMORY hints to match returning objects to stable ids when plausible.`
    : `This is the first commit / full frame.\n${statePrompt.prompt}${memoryBlock}`;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: croppedImageBase64,
            },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const text = textBlock?.type === "text" ? textBlock.text : "";

  try {
    const parsed = extractJson(text);
    Sentry.addBreadcrumb({
      category: "topo.reconcile",
      message: "Claude reconciliation reasoning",
      level: "info",
      data: { reasoning: parsed.reasoning },
    });
    return {
      objects: parsed.objects,
      reasoning: parsed.reasoning,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
      statePrompt,
    };
  } catch (error) {
    Sentry.captureException(error, {
      extra: { rawResponse: text },
    });
    return {
      objects: priorObjects,
      reasoning: "JSON parse failed — carried forward prior state",
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
      statePrompt,
    };
  }
}
