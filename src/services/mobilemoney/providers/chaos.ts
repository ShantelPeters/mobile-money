import { MobileMoneyProvider, ProviderTransactionStatus } from "../mobileMoneyService";

export interface ChaosConfig {
  enabled: boolean;
  latencyChance: number; // 0 to 1
  latencyMs: number;
  errorChance: number; // 0 to 1
  dropChance: number; // 0 to 1
}

export class ChaosMiddleware implements MobileMoneyProvider {
  constructor(
    private inner: MobileMoneyProvider,
    private config: ChaosConfig,
  ) {}

  private shouldInject(chance: number): boolean {
    return this.config.enabled && Math.random() < chance;
  }

  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async applyChaos<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.config.enabled) {
      return operation();
    }

    // 1. Latency injection
    if (this.shouldInject(this.config.latencyChance)) {
      const delay = Math.floor(Math.random() * this.config.latencyMs);
      console.log(`[Chaos] Injecting latency: ${delay}ms`);
      await this.sleep(delay);
    }

    // 2. Connectivity drops (immediate failure or timeout simulation)
    if (this.shouldInject(this.config.dropChance)) {
      console.log("[Chaos] Simulating connectivity drop");
      throw new Error("Chaos: Connectivity drop (ECONNRESET)");
    }

    // 3. 500 Errors (random application-level failure)
    if (this.shouldInject(this.config.errorChance)) {
      console.log("[Chaos] Injecting 500 error");
      // Return a failure result that looks like a 500 from a provider
      return {
        success: false,
        error: {
          message: "Internal Server Error",
          code: "INTERNAL_ERROR",
          status: 500,
        },
      } as any;
    }

    return operation();
  }

  async requestPayment(phoneNumber: string, amount: string) {
    return this.applyChaos(() => this.inner.requestPayment(phoneNumber, amount));
  }

  async sendPayout(phoneNumber: string, amount: string) {
    return this.applyChaos(() => this.inner.sendPayout(phoneNumber, amount));
  }

  async getTransactionStatus(referenceId: string): Promise<{ status: ProviderTransactionStatus }> {
    if (this.inner.getTransactionStatus) {
      return this.applyChaos(() => this.inner.getTransactionStatus!(referenceId));
    }
    return { status: "unknown" };
  }
}
