const UserHandler = require("../handlers/user.handler");
const joiSchemas = require("../validation/crm.general.schema");

module.exports.handleRegistration = async (req, res) => {
  try {
    const results = await joiSchemas.crm_general_register_schema.validateAsync(req.body);

    console.log("results", results);

    const isEmailExists = await UserHandler.findUserByEmail(results.email);
    if (isEmailExists) {
      return res.fail("User already exists");
    }

    const result = await UserHandler.handleNewUser(results.email, results.password);

    return res.success(result);
  } catch (error) {
    console.error("Registration Error:", error);
    return res.serverError(error);
  }
};

module.exports.handleLogin = async (req, res) => {
  try {
    const results = await joiSchemas.crm_general_login_schema.validateAsync(req.body);

    const isEmailExists = await UserHandler.findUserByEmail(results.email);
    if (!isEmailExists) {
      return res.fail("User not found");
    }

    const data = await UserHandler.handleLogin(results.email, results.password);

    return res.success(data);
  } catch (error) {
    console.error("Login Error:", error);
    return res.serverError(error);
  }
};
