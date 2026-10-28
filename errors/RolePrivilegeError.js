/**
 * A role change that crosses the role privilege boundary (handlers/role.handler.js) or puts a role into a
 * state it may never have (models/role.model.js, Phase B / Z3: platform permissions on a tenant role).
 * Mapped to 403 ROLE_PRIVILEGE_VIOLATION by the role controllers.
 */
class RolePrivilegeError extends Error {
  constructor(message) {
    super(message);
    this.name = "RolePrivilegeError";
    this.status = 403;
    this.code = "ROLE_PRIVILEGE_VIOLATION";
  }
}

module.exports = { RolePrivilegeError };
