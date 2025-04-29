const jwt = require("jsonwebtoken");
const UserHandler = require("../handlers/user.handler");

module.exports.ensureAuthenticated = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) return res.fail("Unauthorized");

  try {
    const decoded = jwt.verify(token.replace("Bearer ", ""), process.env.JWT_SECRET);

    const user = await UserHandler.readById(decoded.id);

    if (!user) return res.fail("Unauthorized");

    req.user = user;
    return next();
  } catch (err) {
    console.log(err);
    return res.fail("Unauthorized");
  }
};
