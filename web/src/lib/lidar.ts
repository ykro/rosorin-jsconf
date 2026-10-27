import type { LidarSectorName, LidarSectors } from './types';

/** True when the bridge reports `sector` with no LiDAR coverage (no rays, no braking). */
export function isSectorUncovered(lidar: LidarSectors | undefined | null, sector: LidarSectorName): boolean {
  return Array.isArray(lidar?.uncovered) && lidar.uncovered.includes(sector);
}
