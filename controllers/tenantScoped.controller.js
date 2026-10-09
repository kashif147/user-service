const RoleHandler = require("../handlers/role.handler");
const PermissionHandler = require("../handlers/permission.handler");

// Tenant-scoped role assignment (ASU can only manage within their tenant)
module.exports.assignRoleToUserInTenant = async (req, res) => {
  try {
    const { userId, roleId } = req.body;
    const tenantId = req.ctx.tenantId;
    const assignedBy = req.ctx.userId;

    // Verify the role belongs to the same tenant
    const role = await RoleHandler.getRoleById(roleId, tenantId);
    if (!role) {
      return res.sendBadRequest("Role not found in your tenant");
    }

    // Phase 1C-2B: non-SU may not assign SU/ASU/system roles (checked on the tenant-loaded role doc).
    RoleHandler.assertRoleAssignmentAllowed(
      { roles: Array.isArray(req.ctx?.roles) ? req.ctx.roles : [] },
      [role]
    );

    // Phase 1C-2N: RoleHandler.assignRoleToUser never existed. Delegate to the hardened batch handler
    // (tenant-scoped user + active-role lookup, same protected-role rule, duplicate rejection).
    const result = await RoleHandler.assignRolesToUser(
      userId,
      [roleId],
      tenantId,
      { roles: Array.isArray(req.ctx?.roles) ? req.ctx.roles : [] }
    );
    res.success(result.user);
  } catch (error) {
    if (error instanceof RoleHandler.RolePrivilegeError) {
      return res.status(403).json({ status: "fail", code: error.code, message: error.message });
    }
    // Phase 1C-2N: res.fail() does not exist; map errors like RoleController.assignRolesToUser.
    const message = (error.message || "Failed to assign role to user").replace(
      "Error assigning roles to user: ",
      ""
    );
    if (
      message.includes("Invalid") ||
      message.includes("User not found") ||
      message.includes("Role not found") ||
      message.includes("Roles not found") ||
      message.includes("already has all") ||
      message.includes("Cast to ObjectId failed")
    ) {
      return res.sendBadRequest(message);
    }
    console.error("[assignRoleToUserInTenant]", message);
    return res.sendInternalError("Failed to assign role to user");
  }
};

module.exports.removeRoleFromUserInTenant = async (req, res) => {
  try {
    const { userId, roleId } = req.body;
    const tenantId = req.ctx.tenantId;

    // Verify the role belongs to the same tenant
    const role = await RoleHandler.getRoleById(roleId, tenantId);
    if (!role) {
      return res.fail("Role not found in your tenant");
    }

    // Phase 1C-2C: same protected-role removal rule (actor from trusted req.ctx).
    const user = await RoleHandler.removeRoleFromUser(userId, roleId, tenantId, {
      roles: Array.isArray(req.ctx?.roles) ? req.ctx.roles : [],
    });
    res.success(user);
  } catch (error) {
    if (error instanceof RoleHandler.RolePrivilegeError) {
      return res.status(403).json({ status: "fail", code: error.code, message: error.message });
    }
    res.fail(error.message);
  }
};

// Tenant-scoped permission management (ASU can only manage permissions for roles in their tenant)
module.exports.assignPermissionsToRoleInTenant = async (req, res) => {
  try {
    const { permissions } = req.body;
    const roleId = req.params.id;
    const tenantId = req.ctx.tenantId;
    const updatedBy = req.ctx.userId;

    // Verify the role belongs to the same tenant
    const role = await RoleHandler.getRoleById(roleId, tenantId);
    if (!role) {
      return res.fail("Role not found in your tenant");
    }

    // Verify all permissions exist
    const permissionPromises = permissions.map((permissionCode) =>
      PermissionHandler.getPermissionByCode(permissionCode)
    );
    await Promise.all(permissionPromises);

    const updatedRole = await RoleHandler.updateRolePermissions(
      roleId,
      permissions,
      tenantId,
      updatedBy,
      { roles: Array.isArray(req.ctx?.roles) ? req.ctx.roles : [] }
    );

    res.success(updatedRole);
  } catch (error) {
    // Phase 1C-2B: role privilege boundary violations are 403s.
    if (error instanceof RoleHandler.RolePrivilegeError) {
      return res.status(403).json({ status: "fail", code: error.code, message: error.message });
    }
    res.fail(error.message);
  }
};

// Get users in tenant (ASU can only see users in their tenant)
module.exports.getUsersInTenant = async (req, res) => {
  try {
    const tenantId = req.ctx.tenantId;
    const users = await RoleHandler.getAllUsers(tenantId);
    res.success(users);
  } catch (error) {
    res.fail(error.message);
  }
};

// Get roles in tenant (ASU can only see roles in their tenant)
module.exports.getRolesInTenant = async (req, res) => {
  try {
    const tenantId = req.ctx.tenantId;
    const { userType } = req.query;
    const roles = await RoleHandler.getAllRoles(tenantId, userType);
    res.success(roles);
  } catch (error) {
    res.fail(error.message);
  }
};

// Get permissions available for assignment (ASU can see all permissions but only assign to tenant roles)
module.exports.getAvailablePermissions = async (req, res) => {
  try {
    const filters = {
      category: req.query.category,
      resource: req.query.resource,
      level: req.query.level,
    };
    const permissions = await PermissionHandler.getAllPermissions(filters);
    res.success(permissions);
  } catch (error) {
    res.fail(error.message);
  }
};
