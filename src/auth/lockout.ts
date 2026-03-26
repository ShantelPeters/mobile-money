import { EventEmitter } from "events";

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_LOGIN_ATTEMPTS = parseInt(process.env.MAX_LOGIN_ATTEMPTS ?? "5", 10);
const LOCKOUT_DURATION_MINUTES = parseInt(
  process.env.LOCKOUT_DURATION_MINUTES ?? "30",
  10,
);
const LOCKOUT_DURATION_MS = LOCKOUT_DURATION_MINUTES * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LockoutRecord {
  attempts: number;
  lockedAt: Date | null;
  lastAttemptAt: Date;
}

export interface LockoutStatus {
  isLocked: boolean;
  attemptsRemaining: number;
  lockedAt: Date | null;
  unlocksAt: Date | null;
  minutesRemaining: number | null;
}

export interface LockoutResult {
  success: boolean;
  message: string;
  lockoutStatus: LockoutStatus;
}

// ─── In-Memory Store (swap for Redis/DB in production) ───────────────────────

const lockoutStore = new Map<string, LockoutRecord>();

// ─── Event Emitter for lockout events ────────────────────────────────────────

export const lockoutEvents = new EventEmitter();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the lockout status for a given identifier (e.g. userId or email).
 */
export function getLockoutStatus(identifier: string): LockoutStatus {
  const record = lockoutStore.get(identifier);

  if (!record) {
    return {
      isLocked: false,
      attemptsRemaining: MAX_LOGIN_ATTEMPTS,
      lockedAt: null,
      unlocksAt: null,
      minutesRemaining: null,
    };
  }

  // Auto-unlock: if the lockout window has expired, clear the record
  if (record.lockedAt) {
    const elapsed = Date.now() - record.lockedAt.getTime();
    if (elapsed >= LOCKOUT_DURATION_MS) {
      lockoutStore.delete(identifier);
      lockoutEvents.emit("unlocked", { identifier, reason: "auto" });
      return {
        isLocked: false,
        attemptsRemaining: MAX_LOGIN_ATTEMPTS,
        lockedAt: null,
        unlocksAt: null,
        minutesRemaining: null,
      };
    }

    const unlocksAt = new Date(record.lockedAt.getTime() + LOCKOUT_DURATION_MS);
    const minutesRemaining = Math.ceil(
      (unlocksAt.getTime() - Date.now()) / 60_000,
    );

    return {
      isLocked: true,
      attemptsRemaining: 0,
      lockedAt: record.lockedAt,
      unlocksAt,
      minutesRemaining,
    };
  }

  return {
    isLocked: false,
    attemptsRemaining: Math.max(0, MAX_LOGIN_ATTEMPTS - record.attempts),
    lockedAt: null,
    unlocksAt: null,
    minutesRemaining: null,
  };
}

/**
 * Records a failed login attempt for the given identifier.
 * Locks the account once MAX_LOGIN_ATTEMPTS is reached.
 * Returns a LockoutResult describing the outcome.
 */
export function recordFailedAttempt(identifier: string): LockoutResult {
  // Check if currently locked before recording a new attempt
  const currentStatus = getLockoutStatus(identifier);
  if (currentStatus.isLocked) {
    return {
      success: false,
      message: buildLockedMessage(currentStatus),
      lockoutStatus: currentStatus,
    };
  }

  const now = new Date();
  const existing = lockoutStore.get(identifier);
  const attempts = (existing?.attempts ?? 0) + 1;

  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    // Lock the account
    const record: LockoutRecord = {
      attempts,
      lockedAt: now,
      lastAttemptAt: now,
    };
    lockoutStore.set(identifier, record);

    const unlocksAt = new Date(now.getTime() + LOCKOUT_DURATION_MS);
    const lockoutStatus: LockoutStatus = {
      isLocked: true,
      attemptsRemaining: 0,
      lockedAt: now,
      unlocksAt,
      minutesRemaining: LOCKOUT_DURATION_MINUTES,
    };

    lockoutEvents.emit("locked", {
      identifier,
      attempts,
      lockedAt: now,
      unlocksAt,
    });

    console.warn(
      `[Lockout] Account locked: ${identifier} | attempts: ${attempts} | unlocks at: ${unlocksAt.toISOString()}`,
    );

    return {
      success: false,
      message: buildLockedMessage(lockoutStatus),
      lockoutStatus,
    };
  }

  // Not yet locked — update attempt count
  lockoutStore.set(identifier, {
    attempts,
    lockedAt: null,
    lastAttemptAt: now,
  });

  const attemptsRemaining = MAX_LOGIN_ATTEMPTS - attempts;
  const lockoutStatus: LockoutStatus = {
    isLocked: false,
    attemptsRemaining,
    lockedAt: null,
    unlocksAt: null,
    minutesRemaining: null,
  };

  lockoutEvents.emit("failedAttempt", {
    identifier,
    attempts,
    attemptsRemaining,
  });

  return {
    success: false,
    message:
      attemptsRemaining === 1
        ? `Invalid credentials. Warning: 1 attempt remaining before your account is locked.`
        : `Invalid credentials. ${attemptsRemaining} attempts remaining before lockout.`,
    lockoutStatus,
  };
}

/**
 * Resets the failed-attempt counter on successful login.
 */
export function recordSuccessfulLogin(identifier: string): void {
  if (lockoutStore.has(identifier)) {
    lockoutStore.delete(identifier);
    lockoutEvents.emit("reset", { identifier, reason: "successful_login" });
  }
}

/**
 * Admin: manually unlock an account.
 */
export function adminUnlock(identifier: string, adminId?: string): boolean {
  if (!lockoutStore.has(identifier)) {
    return false;
  }
  lockoutStore.delete(identifier);
  lockoutEvents.emit("unlocked", { identifier, reason: "admin", adminId });
  console.info(
    `[Lockout] Account manually unlocked: ${identifier}${adminId ? ` by admin ${adminId}` : ""}`,
  );
  return true;
}

/**
 * Returns whether an account is currently locked (convenience wrapper).
 */
export function isAccountLocked(identifier: string): boolean {
  return getLockoutStatus(identifier).isLocked;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildLockedMessage(status: LockoutStatus): string {
  return (
    `Your account has been temporarily locked due to too many failed login attempts. ` +
    `Please try again in ${status.minutesRemaining} minute${status.minutesRemaining === 1 ? "" : "s"}, ` +
    `or contact support to unlock your account immediately.`
  );
}
