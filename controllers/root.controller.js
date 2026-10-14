/**
 * GET / - an Azure B2C callback that lands on the root is redirected to /auth/azure-portal with
 * its code and state (unchanged behaviour); anything else renders the homepage. The code, the state
 * and the redirect URL (which carries both) are never logged.
 */
module.exports.root = (req, res) => {
  // Check if this is an Azure B2C callback with authorization code
  if (req.query.code && req.query.state) {
    console.log("Azure B2C callback at root: redirecting to /auth/azure-portal");

    // Redirect to the proper auth endpoint
    return res.redirect(
      `/auth/azure-portal?code=${req.query.code}&state=${req.query.state}`
    );
  }

  // Regular homepage
  res.render("index", { title: "User Service" });
};
