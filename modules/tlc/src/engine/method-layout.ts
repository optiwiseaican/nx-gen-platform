/** Applying a method's track layout to a plate, ported from the tablet engine (engine/method). */
import { clamp } from './image';
import { Track } from './plate';
import { DetectedSpot } from './signal';

/** A track as a method defines it: what is applied where, independent of any one plate. */
export interface TrackTemplate {
  name: string;
  centerMm: number;
  isReference?: boolean;
  sampleVolumeUl?: number | null;
  concentration?: number | null;
  dilutionFactor?: number | null;
}

/** How a method's track layout was matched to a plate. */
export type LayoutMatch = 'DETECTED_POSITIONS' | 'METHOD_POSITIONS';

export const MethodLayout = {
  templatesOf(tracks: Track[]): TrackTemplate[] {
    return [...tracks]
      .sort((a, b) => a.centerMm - b.centerMm)
      .map((t) => ({
        name: t.name,
        centerMm: t.centerMm,
        isReference: t.isReference ?? false,
        sampleVolumeUl: t.sampleVolumeUl ?? null,
        concentration: t.concentration ?? null,
        dilutionFactor: t.dilutionFactor ?? null,
      }));
  },

  /**
   * When the plate shows the same number of lanes as the method defines, names, roles, volumes
   * and concentrations are assigned left to right to the detected lanes. Otherwise the method's
   * nominal positions are used and the caller should ask the user to check them.
   */
  apply(templates: TrackTemplate[], detectedCentersMm: number[], plateWidthMm: number): { tracks: Track[]; match: LayoutMatch } {
    const sortedDetected = [...detectedCentersMm].sort((a, b) => a - b);
    const sortedTemplates = [...templates].sort((a, b) => a.centerMm - b.centerMm);
    const useDetected = sortedDetected.length === sortedTemplates.length && sortedDetected.length > 0;
    const tracks: Track[] = sortedTemplates.map((t, i) => ({
      id: i + 1,
      name: t.name,
      centerMm: useDetected ? sortedDetected[i] : clamp(t.centerMm, 0, plateWidthMm),
      sampleVolumeUl: t.sampleVolumeUl ?? null,
      concentration: t.concentration ?? null,
      isReference: t.isReference ?? false,
      dilutionFactor: t.dilutionFactor ?? null,
    }));
    return { tracks, match: useDetected ? 'DETECTED_POSITIONS' : 'METHOD_POSITIONS' };
  },

  /** The detected spot whose maximum is nearest expectedHrf, if within toleranceHrf. */
  spotNear(spots: DetectedSpot[], expectedHrf: number, toleranceHrf = 5.0): DetectedSpot | null {
    let best: DetectedSpot | null = null;
    for (const s of spots) {
      const d = Math.abs(s.peak.maxHrf - expectedHrf);
      if (d <= toleranceHrf && (best === null || d < Math.abs(best.peak.maxHrf - expectedHrf))) best = s;
    }
    return best;
  },
};
