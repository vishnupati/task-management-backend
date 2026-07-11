// jobs/kafkaKeepAlive.js

const cron = require("node-cron");
const { kafka } = require("../config/kafka");

async function keepKafkaAlive() {
  const producer = kafka.producer();

  try {
    await producer.connect();

    await producer.send({
      topic: "health-check",
      messages: [
        {
          value: JSON.stringify({
            status: "alive",
            timestamp: new Date().toISOString(),
          }),
        },
      ],
    });

    console.log("Kafka keep-alive message sent");
  } catch (error) {
    console.error("Kafka keep-alive failed:", error.message);
  } finally {
    await producer.disconnect();
  }
}

// Every 12 hours
cron.schedule("0 */12 * * *", () => {
  keepKafkaAlive();
});

module.exports = keepKafkaAlive;