import { executeWithCircuitBreaker } from "../../utils/circuitBreaker";
import {
  providerFailoverAlerts,
  providerFailoverTotal,
  transactionErrorsTotal,
  transactionTotal,
} from "../../utils/metrics";
import logger from "../../utils/logger";

export type ProviderTransactionStatus =
  | "completed"
  | "failed"
  | "pending"
  | "unknown";

export class MobileMoneyError extends Error {
  constructor(
    public code: string,
    message: string,
    public originalError?: any,
  ) {
    super(message);
    this.name = "MobileMoneyError";
  }
}

interface ProviderResponse {
  success: boolean;
  data?: any;
  error?: any;
  providerResponseTimeMs?: number;
}

export interface MobileMoneyProvider {
  requestPayment(phoneNumber: string, amount: string, requestId?: string): Promise<ProviderResponse>;
  sendPayout(phoneNumber: string, amount: string, requestId?: string): Promise<ProviderResponse>;
}

/**
 * Lazy provider factory
 * Heavy modules are loaded ONLY when needed
 */
async function loadMobileMoneyProvider(key: string): Promise<MobileMoneyProvider> {
  switch (key) {
    case "mtn": {
      const mod = await import("./providers/mtn");
      return new mod.MTNMobileMoneyProvider() as unknown as MobileMoneyProvider;
    }
    case "airtel": {
      const mod = await import("./providers/airtel");
      // Note: In .js it was new mod.AirtelService()
      return (mod as any).AirtelService ? new (mod as any).AirtelService() : new (mod as any).AirtelMobileMoneyProvider();
    }
    case "orange": {
      const mod = await import("./providers/orange");
      return new mod.OrangeMobileMoneyProvider() as unknown as MobileMoneyProvider;
    }
    default:
      throw new Error(`Unknown provider: ${key}`);
  }
}

export class MobileMoneyService {
  private failoverHistory = new Map<string, number[]>();
  private providers = new Map<string, MobileMoneyProvider>();

  constructor(providers?: Map<string, MobileMoneyProvider>) {
    // Allow dependency injection for tests; otherwise use lazy loading
    if (providers) {
      this.providers = providers;
    }
  }

  private failoverEnabled(): boolean {
    return (
      String(process.env.PROVIDER_FAILOVER_ENABLED || "false").toLowerCase() ===
      "true"
    );
  }

  private getBackupMobileMoneyProviderKey(primary: string): string | null {
    const envKey = `PROVIDER_BACKUP_${primary.toUpperCase()}`;
    const val = process.env[envKey];
    return val ? val.toLowerCase() : null;
  }

  private recordFailover(provider: string): void {
    const now = Date.now();
    const arr = this.failoverHistory.get(provider) ?? [];
    arr.push(now);
    this.failoverHistory.set(provider, arr.slice(-100));
  }

  private checkRepeatedFailovers(provider: string): boolean {
    const WINDOW_MS = 60 * 60 * 1000;
    const THRESHOLD = 3;
    const now = Date.now();
    const arr = this.failoverHistory.get(provider) ?? [];
    const recent = arr.filter((t) => now - t <= WINDOW_MS);
    return recent.length >= THRESHOLD;
  }

  private notifyRepeatedFailovers(provider: string, requestId?: string): void {
    const log = requestId ? logger.child({ requestId }) : logger;
    log.error({ provider }, `Failover alert: provider=${provider} experienced repeated failovers`);
    providerFailoverAlerts.inc({ provider: provider });
  }

  private async getMobileMoneyProviderOrThrow(providerKey: string): Promise<MobileMoneyProvider> {
    if (this.providers.has(providerKey)) {
      return this.providers.get(providerKey)!;
    }
    return await loadMobileMoneyProvider(providerKey);
  }

  private async callMobileMoneyProvider(
    provider: MobileMoneyProvider,
    op: "requestPayment" | "sendPayout",
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ): Promise<ProviderResponse> {
    if (op === "requestPayment") {
      return provider.requestPayment(phoneNumber, amount, requestId);
    }
    return provider.sendPayout(phoneNumber, amount, requestId);
  }

  private getOperationType(op: string): string {
    return op === "requestPayment" ? "payment" : "payout";
  }

  private buildMobileMoneyProviderFailureMessage(
    providerKey: string,
    error: any,
    phase: string,
  ): string {
    const reason =
      error instanceof Error && error.message
        ? error.message
        : "provider operation failed";
    return `${phase} provider '${providerKey}' failed: ${reason}`;
  }

  private async executeMobileMoneyProviderOperation(
    op: "requestPayment" | "sendPayout",
    providerKey: string,
    phoneNumber: string,
    amount: string,
    allowFailover: boolean,
    requestId?: string,
  ): Promise<any> {
    const provider = await this.getMobileMoneyProviderOrThrow(providerKey);
    const operationType = this.getOperationType(op);
    const backupKey =
      allowFailover && this.failoverEnabled()
        ? this.getBackupMobileMoneyProviderKey(providerKey)
        : null;

    const log = requestId ? logger.child({ requestId }) : logger;

    try {
      return await executeWithCircuitBreaker({
        provider: providerKey,
        operation: op,
        execute: async () => {
          const result = await this.callMobileMoneyProvider(
            provider,
            op,
            phoneNumber,
            amount,
            requestId,
          );
          return result.success
            ? {
                success: true,
                provider: providerKey,
                data: result.data,
                providerResponseTimeMs: result.providerResponseTimeMs,
              }
            : {
                success: false,
                provider: providerKey,
                error: result.error,
                providerResponseTimeMs: result.providerResponseTimeMs,
              };
        },
        fallback: backupKey
          ? async (error: any) => {
              if (backupKey === providerKey) {
                return {
                  success: false,
                  provider: providerKey,
                  error: error,
                };
              }

              log.warn(
                { fromProvider: providerKey, toProvider: backupKey, operation: op },
                `Failing over from ${providerKey} to ${backupKey} for ${op}`,
              );

              providerFailoverTotal.inc({
                type: operationType,
                from_provider: providerKey,
                to_provider: backupKey,
                reason: String(error).slice(0, 100),
              });

              this.recordFailover(providerKey);
              if (this.checkRepeatedFailovers(providerKey)) {
                this.notifyRepeatedFailovers(providerKey, requestId);
              }

              return this.executeMobileMoneyProviderOperation(
                op,
                backupKey,
                phoneNumber,
                amount,
                false,
                requestId,
              );
            }
          : undefined,
      });
    } catch (error) {
      transactionTotal.inc({
        type: operationType,
        provider: providerKey,
        status: "failure",
      });
      transactionErrorsTotal.inc({
        type: operationType,
        provider: providerKey,
        error_type: allowFailover ? "provider_or_exception" : "backup_failure",
      });
      throw new MobileMoneyError(
        "PROVIDER_ERROR",
        this.buildMobileMoneyProviderFailureMessage(
          providerKey,
          error,
          allowFailover ? "primary" : "backup",
        ),
        error,
      );
    }
  }

  async initiatePayment(
    provider: string,
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ) {
    const providerKey = provider.toLowerCase();
    const result = await this.executeMobileMoneyProviderOperation(
      "requestPayment",
      providerKey,
      phoneNumber,
      amount,
      true,
      requestId,
    );

    if (result.success) {
      transactionTotal.inc({
        type: "payment",
        provider: result.provider,
        status: "success",
      });
      return {
        success: true,
        data: result.data,
        providerResponseTimeMs: result.providerResponseTimeMs,
      };
    }

    throw new MobileMoneyError(
      "PROVIDER_ERROR",
      `Payment failed for provider '${providerKey}'`,
      result.error,
    );
  }

  async sendPayout(
    provider: string,
    phoneNumber: string,
    amount: string,
    requestId?: string,
  ) {
    const providerKey = provider.toLowerCase();
    const result = await this.executeMobileMoneyProviderOperation(
      "sendPayout",
      providerKey,
      phoneNumber,
      amount,
      true,
      requestId,
    );

    if (result.success) {
      transactionTotal.inc({
        type: "payout",
        provider: result.provider,
        status: "success",
      });
      return {
        success: true,
        data: result.data,
        providerResponseTimeMs: result.providerResponseTimeMs,
      };
    }

    throw new MobileMoneyError(
      "PROVIDER_ERROR",
      `Payout failed for provider '${providerKey}'`,
      result.error,
    );
  }

  getFailoverStats() {
    const stats: Record<string, any> = {};
    for (const [provider, history] of this.failoverHistory.entries()) {
      stats[provider] = {
        failover_count: history.length,
        last_failover: history[history.length - 1],
      };
    }
    return stats;
  }
}