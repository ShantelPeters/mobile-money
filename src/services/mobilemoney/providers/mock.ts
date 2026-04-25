import { MobileMoneyProvider, ProviderTransactionStatus } from "../mobileMoneyService";

export class MockProvider implements MobileMoneyProvider {
  async requestPayment(phoneNumber: string, amount: string) {
    console.log(`[MockProvider] Requesting payment: ${amount} from ${phoneNumber}`);
    return {
      success: true,
      data: {
        transactionId: `mock-pay-${Date.now()}`,
        status: "PENDING",
      },
    };
  }

  async sendPayout(phoneNumber: string, amount: string) {
    console.log(`[MockProvider] Sending payout: ${amount} to ${phoneNumber}`);
    return {
      success: true,
      data: {
        transactionId: `mock-payout-${Date.now()}`,
        status: "SUCCESSFUL",
      },
    };
  }

  async getTransactionStatus(referenceId: string): Promise<{ status: ProviderTransactionStatus }> {
    console.log(`[MockProvider] Checking status for: ${referenceId}`);
    return { status: "completed" };
  }
}
