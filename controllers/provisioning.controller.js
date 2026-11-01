/**
 * Phase B / P1: provisioning control-plane API. Reached only through
 * requirePlatformPermission("platform:provisioning:admin", { mode: "route-enforce" }) (req.platform set):
 * tenant actors - ASU, legacy SU "*", ordinary users - never get here.
 *
 * POST /runs takes EXACTLY { tenantId, templateKey, templateVersion }. The target is the internal tenant id;
 * an organisation code, Entra tid / directory id or domain is refused before anything is read - they are
 * locators, never the ownership boundary. Creating a run records intent and plans steps; it dispatches
 * nothing (P3).
 */
const { AppError } = require("../errors/AppError");
const PlatformTemplate = require("../models/platformTemplate.model");
const { COMPONENTS } = require("../constants/provisioningComponents");
const runs = require("../services/provisioningRunService");
const { auditProvisioningRun } = require("../services/platformAuditService");

const RUN_BODY_FIELDS = new Set(["tenantId", "templateKey", "templateVersion"]);
const LOCATOR_FIELDS = ["code", "orgCode", "organisationCode", "organizationCode", "tenantCode", "tid", "directoryId", "domain", "email"];

const templateView = (t) => ({ key: t.key, version: t.version, description: t.description, status: t.status, contentHash: t.contentHash, components: t.components, publishedAt: t.publishedAt, retiredAt: t.retiredAt || null });

const fail = (next, e) => next(e instanceof AppError ? e : AppError.internalServerError("Provisioning request failed"));

module.exports.listComponents = (req, res) => res.success(COMPONENTS);

module.exports.listTemplates = async (req, res, next) => {
  try {
    const list = await PlatformTemplate.find({}).sort({ key: 1, version: 1 }).lean();
    return res.success(list.map(templateView));
  } catch (e) {
    return fail(next, e);
  }
};

module.exports.getTemplate = async (req, res, next) => {
  try {
    const version = Number(req.params.version);
    const t = Number.isInteger(version) ? await PlatformTemplate.findOne({ key: String(req.params.key), version }).lean() : null;
    if (!t) return next(AppError.notFound("Template not found"));
    return res.success(templateView(t));
  } catch (e) {
    return fail(next, e);
  }
};

module.exports.createRun = async (req, res, next) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const refuse = (status, code, message, reason, tenantId) => {
    auditProvisioningRun({ req, action: "PROVISIONING_RUN_REFUSED", result: "failure", reason, tenantId });
    return next(new AppError(message, status, code));
  };
  if (LOCATOR_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(body, f))) {
    return refuse(400, runs.CODES.INTERNAL_TENANT_ID_REQUIRED, "The target is the internal tenant id; organisation code, directory id and domain are not accepted", "locator_supplied");
  }
  if (Object.keys(body).some((k) => !RUN_BODY_FIELDS.has(k))) return refuse(400, "BAD_REQUEST", "Unexpected field", "unexpected_field");
  try {
    const { run, created } = await runs.createOrGetRun({
      tenantId: body.tenantId,
      templateKey: body.templateKey,
      templateVersion: body.templateVersion,
      principalId: req.platform.pid,
    });
    auditProvisioningRun({ req, action: created ? "PROVISIONING_RUN_CREATED" : "PROVISIONING_RUN_REQUESTED_EXISTING", result: "success", run });
    return res.status(created ? 201 : 200).json({ status: "success", data: { created, run: runs.toRunView(run) } });
  } catch (e) {
    if (e instanceof AppError) {
      const known = e.code === runs.CODES.TENANT_NOT_FOUND ? undefined : body.tenantId;
      return refuse(e.status, e.code, e.message, String(e.code).toLowerCase(), known);
    }
    return fail(next, e);
  }
};

module.exports.listRuns = async (req, res, next) => {
  try {
    const list = await runs.listRuns({ tenantId: req.query.tenantId });
    return res.success(list.map(runs.toRunView));
  } catch (e) {
    return fail(next, e);
  }
};

module.exports.getRun = async (req, res, next) => {
  try {
    return res.success(runs.toRunView(await runs.getRun(req.params.runId)));
  } catch (e) {
    return fail(next, e);
  }
};

module.exports.resumeRun = async (req, res, next) => {
  try {
    const run = await runs.resumeRun({ runId: req.params.runId, principalId: req.platform.pid });
    auditProvisioningRun({ req, action: "PROVISIONING_RUN_RESUMED", result: "success", run });
    return res.success(runs.toRunView(run));
  } catch (e) {
    if (e instanceof AppError) auditProvisioningRun({ req, action: "PROVISIONING_RUN_REFUSED", result: "failure", reason: String(e.code).toLowerCase() });
    return fail(next, e);
  }
};
