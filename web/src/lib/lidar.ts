import type { LidarSectorName, LidarSectors } from './types';

/** True when the bridge reports `sector` with no LiDAR coverage (no rays, no braking). */
export function isSectorUncovered(lidar: LidarSectors | undefined | null, sector: LidarSectorName): boolean {
  return Array.isArray(lidar?.uncovered) && lidar.uncovered.includes(sector);
}

/** Brake distance of the bridge (LIDAR_BRAKE_M in robot-bridge/src/backend.rs). */
export const LIDAR_BRAKE_M = 0.28;
/** The twin only draws echoes closer than this; farther away the sector is open. */
export const LIDAR_MARKER_MAX_M = 0.85;

/** Direction of each sector's centre in the robot frame (REP-103: +x forward, +y left). */
export const LIDAR_SECTOR_ANGLE_RAD: Record<LidarSectorName, number> = {
  front: 0,
  left: Math.PI / 2,
  right: -Math.PI / 2,
  back: Math.PI,
};

export interface LidarMarker {
  sector: LidarSectorName;
  /** Sector centre in the robot frame. */
  angleRad: number;
  /** `echo`: something at `distanceM`. `blind`: the sector reads 0.0 (covered or dirty window). */
  kind: 'echo' | 'blind';
  distanceM: number;
  /** Inside the brake distance: the bridge blocks motion toward that side. */
  braking: boolean;
}

const SECTORS: LidarSectorName[] = ['front', 'left', 'right', 'back'];

/**
 * What the twin should draw for each sector: nothing for an uncovered sector (no LiDAR there, the
 * 0.0 it reads is not an obstacle) or an open one, a «ciego» wedge for a blind sector (0.0 with
 * coverage) and a wall at the measured distance for a real echo.
 */
export function lidarMarkers(lidar: LidarSectors | undefined | null): LidarMarker[] {
  if (!lidar) return [];
  const markers: LidarMarker[] = [];
  for (const sector of SECTORS) {
    if (isSectorUncovered(lidar, sector)) continue;
    const d = lidar[`${sector}_m`];
    if (typeof d !== 'number' || !Number.isFinite(d)) continue;
    const angleRad = LIDAR_SECTOR_ANGLE_RAD[sector];
    if (d <= 0.001) {
      markers.push({ sector, angleRad, kind: 'blind', distanceM: 0, braking: true });
    } else if (d < LIDAR_MARKER_MAX_M) {
      markers.push({ sector, angleRad, kind: 'echo', distanceM: d, braking: d < LIDAR_BRAKE_M });
    }
  }
  return markers;
}

/** The bridge's obstacle_alert, or any covered sector inside the brake distance. */
export function lidarAlert(lidar: LidarSectors | undefined | null): boolean {
  if (!lidar) return false;
  return Boolean(lidar.obstacle_alert) || lidarMarkers(lidar).some((m) => m.braking);
}
