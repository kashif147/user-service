const mongoose = require("mongoose");

exports.mongooseConnection = async () => {
  try {
    // Build connection string with environment variables
    const mongoUri =
      process.env.MONGO_URI ||
      `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@clusterprojectshell.tptnh8w.mongodb.net/${process.env.MONGO_DB}/?retryWrites=true&w=majority&appName=ClusterProjectShell`;

    await mongoose.connect(mongoUri).then((data) => {
      console.log(
        `SuccessFully Connected to the MongoDB ===> "${data.connection.name}"`
      );
    });
  } catch (e) {
    console.error("Unable to connect to database:", e);
  }
};
