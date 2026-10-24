// SPDX-License-Identifier: Apache-2.0
// Resolve a start-sorted sweep against the last retained range, avoiding quadratic scans.
import { DetectionSchema } from "@rovinos/schemas";
import { PiiDetectorError } from "./types.js";
import type { Detection } from "./types.js";

/** Keep longer overlaps, then higher confidence, then lexically lower detector IDs. */
export function resolveOverlaps(detections: Detection[]): Detection[] {
  const sorted = detections
    .map((detection) => {
      const parsed = DetectionSchema.safeParse(detection);
      if (!parsed.success) {
        throw new PiiDetectorError("pii_detector_invalid_input");
      }
      return parsed.data;
    })
    .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
  const kept: Detection[] = [];
  for (const detection of sorted) {
    const previous = kept.at(-1);
    if (previous === undefined || detection.start >= previous.end) {
      kept.push(detection);
    } else if (preferred(detection, previous)) {
      kept[kept.length - 1] = detection;
    }
  }
  return kept;
}

function preferred(candidate: Detection, previous: Detection): boolean {
  const lengthDifference = candidate.end - candidate.start - (previous.end - previous.start);
  if (lengthDifference !== 0) {
    return lengthDifference > 0;
  }
  if (candidate.confidence !== previous.confidence) {
    return candidate.confidence > previous.confidence;
  }
  return candidate.detectorId < previous.detectorId;
}
