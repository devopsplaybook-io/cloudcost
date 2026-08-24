import { NotificationClient } from "./NotificationClient";
import { Config } from "./Config";
import { CLOUDS, cost } from "./CloudDefinitions";
import { OTelLogger } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("notification-service");

let notificationClient: NotificationClient | null = null;
let config: Config;

// Track the last notified threshold level to avoid spamming
// When cost crosses a threshold multiple (e.g., $10, $20, $30), notify once per multiple
let lastNotifiedThresholdMultiple = 0;

/**
 * Initialize the notification service.
 */
export function NotificationInit(configIn: Config): void {
  config = configIn;

  if (config.NOTIFICATIONS_API && config.NOTIFICATIONS_TOKEN) {
    notificationClient = new NotificationClient({
      apiEndpoint: config.NOTIFICATIONS_API,
      apiToken: config.NOTIFICATIONS_TOKEN,
    });
    logger.info(
      `Notification service initialized (threshold: $${config.COST_NOTIFICATION_THRESHOLD})`,
    );
  } else {
    logger.info(
      "Notification service disabled (NOTIFICATIONS_API or NOTIFICATIONS_TOKEN not set)",
    );
  }
}

/**
 * Check if the total cost has crossed a threshold and send a notification.
 * Notifies once per threshold multiple (e.g., $10, $20, $30) to avoid spam.
 */
export async function NotificationCheckThreshold(): Promise<void> {
  if (!notificationClient) {
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

    try {
      await notificationClient.warning(title, body, "cloudcost");
      logger.info(`Threshold notification sent: ${title}`);
    } catch (err) {
      logger.error("Failed to send threshold notification", err);
    }
  }
}

/**
 * Reset the threshold tracking (useful for testing or month rollover).
 */
export function NotificationResetThreshold(): void {
  lastNotifiedThresholdMultiple = 0;
}
