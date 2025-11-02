const mongoose = require("mongoose");

exports.mongooseConnection = async () => {
  try {
    // Build connection string with environment variables
    const mongoUri =
      process.env.MONGO_URI ||
      `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@clusterprojectshell.tptnh8w.mongodb.net/${process.env.MONGO_DB}/?retryWrites=true&w=majority&appName=ClusterProjectShell`;

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
