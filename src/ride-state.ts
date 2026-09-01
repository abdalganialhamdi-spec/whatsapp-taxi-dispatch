/**
 * آلة حالات الرحلة — الانتقالات المسموحة فقط، وكل انتقال له رسائل (زبون/مجموعة).
 * Ride state machine — no illegal transitions, Arabic replies.
 */

import type { RideStatus } from './types.js';

export const ALLOWED: Record<RideStatus, RideStatus[]> = {
  NEW: ['DISPATCHING', 'CANCELLED'],
  DISPATCHING: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['ARRIVED', 'CANCELLED'],
  ARRIVED: ['IN_RIDE', 'CANCELLED'],
  IN_RIDE: ['DONE', 'CANCELLED'],
  DONE: [],
  CANCELLED: [],
};

export function canTransition(from: RideStatus, to: RideStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export class IllegalTransition extends Error {
  constructor(from: RideStatus, to: RideStatus) {
    super(`انتقال غير مسموح: ${from} → ${to}`);
  }
}

export function assertTransition(from: RideStatus, to: RideStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}
