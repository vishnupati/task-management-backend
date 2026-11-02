// jobs/kafkaKeepAlive.ts

import cron from "node-cron";
import { publish, TOPICS } from "../lib";
import { getErrorMessage } from "../utils";

// Aiven's free tier powers Kafka off after 24h without produce/consume traffic. This only helps while the
// process is running: if the host sleeps when idle (e.g. Render free instances), the cron never fires.
async function keepKafkaAlive(): Promise<void> {
  try {
    await publish({
      topic: TOPICS.HEALTH_CHECK,
      event: "keep_alive",
      message: { status: "alive", timestamp: new Date().toISOString() },
    });

    console.log("Kafka keep-alive message sent");
  } catch (error) {
    console.error("Kafka keep-alive failed:", getErrorMessage(error));
  }
}

// Every 12 hours
cron.schedule("0 */12 * * *", () => {
  keepKafkaAlive();
});

export default keepKafkaAlive;
