const mongoose = require("mongoose");

exports.mongooseConnection = async () => {
  // No built-in fallback: without MONGO_URI the service must not start, and it must never connect
  // with a default credential.
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is not set; refusing to start without database configuration");
  }
  try {

    // Connection options for better Atlas connectivity
    // Reduced timeouts for faster failure detection (especially important for Azure B2C validation endpoint)
    const options = {
      serverSelectionTimeoutMS: 10000, // Reduced from 30s to 10s
      connectTimeoutMS: 10000, // Reduced from 30s to 10s
      socketTimeoutMS: 15000, // Reduced from 30s to 15s
      maxPoolSize: 10, // Limit connection pool size
      minPoolSize: 2, // Maintain minimum connections
      maxIdleTimeMS: 30000, // Close idle connections after 30s
    };

    await mongoose.connect(mongoUri, options).then((data) => {
      console.log(
        `SuccessFully Connected to the MongoDB ===> "${data.connection.name}"`
      );
    });
  } catch (e) {
    console.error("Unable to connect to database:", e);
  }
};
