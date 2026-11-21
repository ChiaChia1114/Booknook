/**
 * Drone 3D models (no Cesium import, so pages can resolve models without pulling the
 * CesiumJS bundle into the main chunk; the 3D views load Cesium lazily).
 */
import { DEFAULT_AIRFRAME_ID, airframeById, type AirframeModel } from '@athena-sky/shared';

export type DroneModel = AirframeModel;

/** Model shown for drones without an airframe. */
export const DEFAULT_DRONE_MODEL: DroneModel = airframeById(DEFAULT_AIRFRAME_ID)?.model ?? 'specter-10x';

/** 3D model of an airframe (the operator's own models; generated VTOL). */
export const droneModelUri = (m: DroneModel | null | undefined) => `/models/${m ?? DEFAULT_DRONE_MODEL}.glb`;

export function modelOfAirframe(airframeId: string | null | undefined): DroneModel {
  return airframeById(airframeId)?.model ?? DEFAULT_DRONE_MODEL;
}
