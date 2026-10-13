// Test-only Entra (CRM sign-in) configuration. The application has no built-in fallbacks
// (helpers/entraConfig.js), so the suites that exercise sign-in get these fixed test values.
// Applied only where the variable is unset; tests that check the missing-configuration path
// delete them explicitly. Not real credentials.
const TEST_ENTRA_ENV = {
  AZURE_AD_TENANT_ID: "39866a06-30bc-4a89-80c6-9dd9357dd453",
  AZURE_AD_CLIENT_ID: "ad25f823-e2d3-43e2-bea5-a9e6c9b0dbae",
  AZURE_AD_CLIENT_SECRET: "test-client-secret",
  AZURE_AD_REDIRECT_URI: "http://localhost:3000/auth/azure-crm",
};
for (const [k, v] of Object.entries(TEST_ENTRA_ENV)) {
  if (!process.env[k]) process.env[k] = v;
}
