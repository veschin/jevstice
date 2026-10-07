/** Canonical decision-stage key set: derived from the control-point registry (single source). */
import { CONTROL_POINT_REGISTRY } from "./control-points.js";

export const STAGES: ReadonlySet<string> = new Set(Object.keys(CONTROL_POINT_REGISTRY));
