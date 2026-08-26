import { NotificationsClient } from "@devopsplaybook.io/common-utils";
import { Config } from "./Config";
import { CLOUDS, cost } from "./CloudDefinitions";
import { OTelLogger } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("notification-service");

let notificationClient: NotificationsClient | null = null;
let config: Config;

// Track the last notified threshold level to avoid spamming
// When cost crosses a threshold multiple (e.g., $10, $20, $30), notify once per multiple
let lastNotifiedThresholdMultiple = 0;

/**
 * Initialize the notification service.
 *
 * The shared client logs the integration status (enabled or disabled) once
 * at construction and never throws on partially configured settings.
 */
export function NotificationInit(configIn: Config): void {
  config = configIn;
  notificationClient = new NotificationsClient({
    apiEndpoint: config.NOTIFICATIONS_API,
    apiToken: config.NOTIFICATIONS_TOKEN,
    logger,
  });
}

/**
 * Check if the total cost has crossed a threshold and send a notification.
 * Notifies once per threshold multiple (e.g., $10, $20, $30) to avoid spam.
 */
export async function NotificationCheckThreshold(): Promise<void> {
  if (!notificationClient || !notificationClient.isEnabled()) {
    return;
  }

  // Calculate total cost across all enabled clouds
  let totalCost = 0;
  for (const cloud of CLOUDS) {
    if (config[cloud.configFlag]) {
      totalCost += cost[cloud.key].total;
    }
  }

  const threshold = config.COST_NOTIFICATION_THRESHOLD;
  if (threshold <= 0) {
    return;
  }

  // Calculate which threshold multiple we've crossed
  const currentMultiple = Math.floor(totalCost / threshold);

  // Only notify if we've crossed a new threshold multiple
  if (currentMultiple > lastNotifiedThresholdMultiple && currentMultiple > 0) {
    lastNotifiedThresholdMultiple = currentMultiple;

    const thresholdAmount = currentMultiple * threshold;
    const breakdown = CLOUDS.filter((c) => config[c.configFlag])
      .map((c) => `${c.label}: $${cost[c.key].total.toFixed(2)}`)
      .join(", ");

    const title = `Cloud cost threshold reached: $${thresholdAmount.toFixed(2)}`;
    const body = `Total month-to-date cost has reached $${totalCost.toFixed(2)} (${breakdown})`;

    const response = await notificationClient.warning(
      title,
      body,
      "cloudcost",
    );
    if (response) {
      logger.info(`Threshold notification sent: ${title}`);
    }
  }
}

/**
 * Reset the threshold tracking (useful for testing or month rollover).
 */
export function NotificationResetThreshold(): void {
  lastNotifiedThresholdMultiple = 0;
}
