const Role = require("../models/role.model");
const User = require("../models/user.model");
const Tenant = require("../models/tenant.model");
const Permission = require("../models/permission.model");
const mongoose = require("mongoose");

module.exports.initializeRoles = async (tenantId) => {
  try {
    // Check if roles already exist for this tenant
    const existingRoles = await Role.find({ tenantId });
    if (existingRoles.length > 0) {
      console.log(
        `Roles already initialized for tenant ${tenantId} - Found ${existingRoles.length} roles`
      );
      return existingRoles;
    }

    // If no roles exist, they should have been created during migration
    console.log(
      `No roles found for tenant ${tenantId}. Please run the migration script first.`
    );
    return [];
  } catch (error) {
    throw new Error(`Error initializing roles: ${error.message}`);
  }
};

module.exports.getAllRoles = async (tenantId, category = null) => {
  try {
    const query = { tenantId, isActive: true };
    if (category) {
      query.category = category;
    }
    
    // Use lean() for better performance and ensure we get all results
    const roles = await Role.find(query)
      .sort({ category: 1, name: 1 })
      .lean()
      .exec();
    
    console.log(`[getAllRoles] Found ${roles.length} roles for tenantId: ${tenantId}, category: ${category || 'all'}`);

    const permissionValues = [
      ...new Set(roles.flatMap((role) => role.permissions || []).filter(Boolean)),
    ];
    const permissionObjectIds = permissionValues.filter(
      (perm) => mongoose.Types.ObjectId.isValid(perm) && perm.length === 24
    );
    const permissionCodes = permissionValues.filter(
      (perm) => !(mongoose.Types.ObjectId.isValid(perm) && perm.length === 24)
    );

    const permissionDocs =
      permissionValues.length > 0
        ? await Permission.find({
            $or: [
              ...(permissionObjectIds.length
                ? [{ _id: { $in: permissionObjectIds } }]
                : []),
              ...(permissionCodes.length ? [{ code: { $in: permissionCodes } }] : []),
            ],
          })
            .select("name code description")
            .lean()
        : [];

    const permissionsById = new Map(
      permissionDocs.map((permission) => [permission._id.toString(), permission])
    );
    const permissionsByCode = new Map(
      permissionDocs.map((permission) => [permission.code, permission])
    );

    const toPermissionPayload = (perm) => {
      const permission =
        permissionsById.get(String(perm)) || permissionsByCode.get(String(perm));
      if (!permission) {
        return { code: perm, name: perm };
      }
      return {
        _id: permission._id,
        name: permission.name,
        code: permission.code,
        description: permission.description,
      };
    };

    const rolesWithPermissions = roles.map((role) => ({
      ...role,
      permissions: (role.permissions || []).map(toPermissionPayload),
    }));

    console.log(`[getAllRoles] Returning ${rolesWithPermissions.length} roles with transformed permissions`);
    return rolesWithPermissions;
  } catch (error) {
    throw new Error(`Error fetching roles: ${error.message}`);
  }
};

module.exports.getRoleByCode = async (code, tenantId) => {
  try {
    const role = await Role.findOne({ code, tenantId, isActive: true });
    if (!role) {
      throw new Error("Role not found");
    }
    return role;
  } catch (error) {
    throw new Error(`Error fetching role: ${error.message}`);
  }
};

module.exports.getRoleById = async (roleId, tenantId) => {
  try {
    const role = await Role.findOne({ _id: roleId, tenantId });
    if (!role) {
      throw new Error("Role not found");
    }

    // Transform permissions to include full details
    const roleObj = role.toObject();
    const transformedPermissions = await Promise.all(
      roleObj.permissions.map(async (perm) => {
        // Check if permission is an ObjectId
        if (mongoose.Types.ObjectId.isValid(perm) && perm.length === 24) {
          const permDoc = await Permission.findById(perm);
          if (permDoc) {
            return {
              _id: permDoc._id,
              name: permDoc.name,
              code: permDoc.code,
              description: permDoc.description,
            };
          }
        }
        // If it's a string code, try to find by code
        const permByCode = await Permission.findOne({ code: perm });
        if (permByCode) {
          return {
            _id: permByCode._id,
            name: permByCode.name,
            code: permByCode.code,
            description: permByCode.description,
          };
        }
        // Return as-is if not found
        return { code: perm, name: perm };
      })
    );
    roleObj.permissions = transformedPermissions;

    return roleObj;
  } catch (error) {
    throw new Error(`Error fetching role: ${error.message}`);
  }
};

// ---------------------------------------------------------------------------
// Phase 1C-2B (M1): role privilege boundary.
//
// SU is identified purely by role code ("SU"), ASU by "ASU"; a "*" permission satisfies every PDP
// permission check; and role levels are merged platform-wide by code (roleHierarchyService). So a
// non-SU actor editing role definitions could otherwise mint platform-admin access. Rules for
// non-SU actors (actor roles come from the trusted, authenticated req.ctx — never the body):
//   - cannot create/rename a role to a reserved code (SU, ASU)
//   - cannot modify an existing SU/ASU role or any role whose persisted isSystemRole is true
//   - cannot create a role with isSystemRole: true
//   - cannot set level >= ASU's level (platform-admin tier) or category SYSTEM
//   - cannot ADD reserved permissions: "*", platform-catalogue / tenant-creation / admin-resource
//     permissions, or any ":super_admin" action (permissions already on the role are untouched)
// SU actors are exempt. tenantId/_id/Mongo operators stay non-editable for everyone.
// ---------------------------------------------------------------------------
const RESERVED_ROLE_CODES = ["SU", "ASU"];
const PLATFORM_ADMIN_MIN_LEVEL = 95; // ASU level in roleHierarchyService's fallback hierarchy
const RESERVED_CATEGORIES = ["SYSTEM"];
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

const isReservedPermission = (canonical) => {
  if (!canonical) return false;
  if (canonical === "*") return true;
  const [resource, action] = canonical.split(":");
  if (action === "super_admin") return true;
  if (resource === "admin") return true; // platform admin resource (e.g. global cache control)
  if (resource === "permission" && action !== "read") return true; // global permission catalogue
  if (resource === "tenant" && action === "create") return true; // new tenants
  return false;
};

const toCanonicalPermission = (perm) => {
  if (!perm || typeof perm !== "string") return null;
  const p = perm.trim();
  if (p === "*") return "*";
  if (p.includes(":")) return p.toLowerCase();
  return p.toLowerCase().replace(/_/g, ":"); // CODE_FORMAT -> resource:action (as helpers/jwt.js)
};

class RolePrivilegeError extends Error {
  constructor(message) {
    super(message);
    this.name = "RolePrivilegeError";
    this.status = 403;
    this.code = "ROLE_PRIVILEGE_VIOLATION";
  }
}

const isSuperUserActor = (actor) =>
  Array.isArray(actor?.roles) &&
  actor.roles.some((r) => (typeof r === "string" ? r : r?.code) === "SU");

// Canonical form of permission entries the role does not already have (ObjectId entries resolved).
const canonicalAddedPermissions = async (proposed, existing = []) => {
  const resolve = async (entries) => {
    const list = (Array.isArray(entries) ? entries : []).map((e) => String(e).trim());
    const ids = list.filter((e) => OBJECT_ID_RE.test(e));
    const byId = new Map();
    if (ids.length) {
      const docs = await Permission.find({ _id: { $in: ids } }).select("code resource action");
      for (const d of docs) {
        byId.set(
          String(d._id),
          d.resource && d.action ? `${d.resource}:${d.action}`.toLowerCase() : toCanonicalPermission(d.code)
        );
      }
    }
    return list.map((e) => (OBJECT_ID_RE.test(e) ? byId.get(e) || `unresolved:${e}` : toCanonicalPermission(e)));
  };
  const have = new Set(await resolve(existing));
  return (await resolve(proposed)).filter((p) => !have.has(p));
};

/**
 * Throws RolePrivilegeError when a non-SU actor's role change would cross the privilege boundary.
 * persisted: the current role document (null on create). proposed: the fields being written.
 */
const assertRoleChangeAllowed = async (actor, persisted, proposed) => {
  if (!actor || !Array.isArray(actor.roles)) {
    throw new RolePrivilegeError("Actor context required for role changes");
  }
  if (isSuperUserActor(actor)) return;

  const code = (v) => (v == null ? "" : String(v).trim().toUpperCase());
  if (persisted) {
    if (RESERVED_ROLE_CODES.includes(code(persisted.code))) {
      throw new RolePrivilegeError(`Only SU may modify the ${code(persisted.code)} role`);
    }
    if (persisted.isSystemRole === true) {
      throw new RolePrivilegeError("Only SU may modify a system role");
    }
  }
  if (proposed.code !== undefined && RESERVED_ROLE_CODES.includes(code(proposed.code))) {
    throw new RolePrivilegeError(`Role code ${code(proposed.code)} is reserved`);
  }
  if (proposed.isSystemRole === true) {
    throw new RolePrivilegeError("Only SU may create a system role");
  }
  if (proposed.level !== undefined && Number(proposed.level) >= PLATFORM_ADMIN_MIN_LEVEL) {
    throw new RolePrivilegeError(`Role level ${proposed.level} is reserved for platform roles`);
  }
  if (proposed.category !== undefined && RESERVED_CATEGORIES.includes(code(proposed.category))) {
    throw new RolePrivilegeError(`Role category ${code(proposed.category)} is reserved`);
  }
  if (proposed.permissions !== undefined) {
    const added = await canonicalAddedPermissions(proposed.permissions, persisted?.permissions || []);
    const reserved = added.filter(isReservedPermission);
    if (reserved.length) {
      throw new RolePrivilegeError(`Only SU may grant platform permissions: ${reserved.join(", ")}`);
    }
  }
};

// Phase 1C-2B: role ASSIGNMENT boundary — same reserved codes / system flag / SU detection as the
// role-definition rules above. A role is protected when its PERSISTED document has code SU/ASU
// (case/whitespace-insensitive) or isSystemRole: true. Non-SU actors may not assign protected
// roles to anyone (including themselves). Callers pass role documents loaded with the trusted
// tenantId; nothing from the request body (ids or codes) is trusted. The error message is generic.
const isProtectedRole = (role) =>
  !!role &&
  (RESERVED_ROLE_CODES.includes(String(role.code == null ? "" : role.code).trim().toUpperCase()) ||
    role.isSystemRole === true);

const assertRoleAssignmentAllowed = (actor, roleDocs) => {
  if (!actor || !Array.isArray(actor.roles)) {
    throw new RolePrivilegeError("Actor context required for role assignment");
  }
  if (isSuperUserActor(actor)) return;
  if ((roleDocs || []).some(isProtectedRole)) {
    throw new RolePrivilegeError("Only SU may assign platform or system roles");
  }
};

// Phase 1C-2C: role REMOVAL boundary — same protected-role model (isProtectedRole / isSuperUserActor
// / RolePrivilegeError). Non-SU actors may not remove a role whose persisted, tenant-scoped document
// is protected. Role docs are loaded with {_id: {$in}, tenantId} only (never _id alone, no isActive
// filter so an inactive protected role is still protected).
//  - requested removals (remove-role / remove-roles-batch): every requested id must resolve in the
//    tenant (else "Roles not found" -> 400); any protected one -> 403.
//  - implicit removals (sync-roles: held roles not in the new set): any protected one, or one that
//    cannot be resolved in the tenant (unverifiable), -> 403 (fail closed).
const loadTenantRoles = async (ids, tenantId) => {
  for (const id of ids) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error(`Invalid roleId format: ${id}. ObjectId must be a 24-character hex string.`);
    }
  }
  return ids.length ? Role.find({ _id: { $in: ids }, tenantId }) : [];
};

const assertRequestedRoleRemovalAllowed = async (actor, tenantId, requestedIds) => {
  if (!actor || !Array.isArray(actor.roles)) {
    throw new RolePrivilegeError("Actor context required for role removal");
  }
  if (isSuperUserActor(actor)) return;
  const ids = [...new Set((requestedIds || []).map(String))];
  const docs = await loadTenantRoles(ids, tenantId);
  const found = new Set(docs.map((d) => String(d._id)));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new Error(`Roles not found: ${missing.join(", ")}`);
  if (docs.some(isProtectedRole)) {
    throw new RolePrivilegeError("Only SU may remove platform or system roles");
  }
};

const assertImplicitRoleRemovalAllowed = async (actor, tenantId, removedIds) => {
  if (!actor || !Array.isArray(actor.roles)) {
    throw new RolePrivilegeError("Actor context required for role removal");
  }
  if (isSuperUserActor(actor)) return;
  const ids = [...new Set((removedIds || []).map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id));
  const docs = ids.length ? await Role.find({ _id: { $in: ids }, tenantId }) : [];
  const unverifiable = docs.length !== ids.length || (removedIds || []).some((id) => !mongoose.Types.ObjectId.isValid(String(id)));
  if (unverifiable || docs.some(isProtectedRole)) {
    throw new RolePrivilegeError("Only SU may remove platform or system roles");
  }
};

module.exports.RolePrivilegeError = RolePrivilegeError;
module.exports.assertRoleChangeAllowed = assertRoleChangeAllowed;
module.exports.assertRoleAssignmentAllowed = assertRoleAssignmentAllowed;
module.exports.assertRequestedRoleRemovalAllowed = assertRequestedRoleRemovalAllowed;
module.exports.assertImplicitRoleRemovalAllowed = assertImplicitRoleRemovalAllowed;
module.exports.isProtectedRole = isProtectedRole;
module.exports.isReservedPermission = isReservedPermission;

module.exports.createRole = async (roleData, tenantId, createdBy, actor) => {
  try {
    await assertRoleChangeAllowed(actor, null, roleData || {});
    const role = new Role({
      ...roleData,
      tenantId,
      createdBy,
    });
    await role.save();
    return role;
  } catch (error) {
    if (error instanceof RolePrivilegeError) throw error;
    throw new Error(`Error creating role: ${error.message}`);
  }
};

// Phase 1C-2B: fields a role update may change. Everything else in the request body — notably
// tenantId (would move the role to another tenant), _id, isSystemRole and audit fields — is ignored.
const ROLE_UPDATABLE_FIELDS = [
  "name",
  "code",
  "description",
  "category",
  "level",
  "permissions",
  "isActive",
];

module.exports.ROLE_UPDATABLE_FIELDS = ROLE_UPDATABLE_FIELDS;

module.exports.updateRole = async (roleId, updateData, tenantId, updatedBy, actor) => {
  try {
    const changes = {};
    for (const field of ROLE_UPDATABLE_FIELDS) {
      if (updateData && Object.prototype.hasOwnProperty.call(updateData, field)) {
        changes[field] = updateData[field];
      }
    }
    const persisted = await Role.findOne({ _id: roleId, tenantId });
    if (!persisted) {
      throw new Error("Role not found");
    }
    await assertRoleChangeAllowed(actor, persisted, changes);
    const role = await Role.findOneAndUpdate(
      { _id: roleId, tenantId },
      { $set: { ...changes, updatedAt: Date.now(), updatedBy } },
      { new: true }
    );

    if (!role) {
      throw new Error("Role not found");
    }
    return role;
  } catch (error) {
    if (error instanceof RolePrivilegeError) throw error;
    throw new Error(`Error updating role: ${error.message}`);
  }
};

module.exports.deleteRole = async (roleId, tenantId) => {
  try {
    const role = await Role.findOne({ _id: roleId, tenantId });
    if (!role) {
      throw new Error("Role not found");
    }

    if (role.isSystemRole) {
      throw new Error("Cannot delete system role");
    }

    // Check if any users have this role in this tenant
    const usersWithRole = await User.find({ roles: roleId, tenantId });
    if (usersWithRole.length > 0) {
      throw new Error("Cannot delete role that is assigned to users");
    }

    await Role.findOneAndUpdate({ _id: roleId, tenantId }, { isActive: false });
    return { message: "Role deleted successfully" };
  } catch (error) {
    throw new Error(`Error deleting role: ${error.message}`);
  }
};

module.exports.updateRolePermissions = async (
  roleId,
  permissions,
  tenantId,
  updatedBy,
  actor
) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(roleId)) {
      throw new Error(
        `Invalid roleId format: ${roleId}. ObjectId must be a 24-character hex string.`
      );
    }

    const persisted = await Role.findOne({ _id: roleId, tenantId });
    if (!persisted) {
      throw new Error("Role not found");
    }
    await assertRoleChangeAllowed(actor, persisted, {
      permissions: Array.isArray(permissions) ? permissions : [],
    });

    const update = {
      $set: {
        permissions: Array.isArray(permissions) ? permissions : [],
        updatedAt: Date.now(),
        updatedBy: updatedBy || null,
      },
    };

    const role = await Role.findOneAndUpdate(
      { _id: roleId, tenantId },
      update,
      { new: true }
    );

    if (!role) {
      throw new Error("Role not found");
    }
    return role;
  } catch (error) {
    if (error instanceof RolePrivilegeError) throw error;
    throw new Error(`Error updating role permissions: ${error.message}`);
  }
};

module.exports.assignRolesToUser = async (userId, roleIds, tenantId, actor) => {
  try {
    assertRoleAssignmentAllowed(actor, []); // actor context required (fail closed)
    // Validate ObjectId formats
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new Error(
        `Invalid userId format: ${userId}. ObjectId must be a 24-character hex string.`
      );
    }

    for (const roleId of roleIds) {
      if (!mongoose.Types.ObjectId.isValid(roleId)) {
        throw new Error(
          `Invalid roleId format: ${roleId}. ObjectId must be a 24-character hex string.`
        );
      }
    }

    const user = await User.findOne({ _id: userId, tenantId });

    if (!user) {
      throw new Error("User not found");
    }

    // Validate all roles exist and belong to the tenant
    const roles = await Role.find({
      _id: { $in: roleIds },
      tenantId,
      isActive: true,
    });

    if (roles.length !== roleIds.length) {
      const foundRoleIds = roles.map((role) => role._id.toString());
      const missingRoleIds = roleIds.filter((id) => !foundRoleIds.includes(id));
      throw new Error(`Roles not found: ${missingRoleIds.join(", ")}`);
    }

    // Phase 1C-2B: validate EVERY requested role (tenant-scoped persisted docs) before touching the user.
    assertRoleAssignmentAllowed(actor, roles);

    // Check which roles user already has
    const existingRoleIds = (user.roles || []).map((roleId) =>
      roleId.toString()
    );
    const newRoleIds = roleIds.filter(
      (roleId) => !existingRoleIds.includes(roleId)
    );
    const alreadyAssignedRoleIds = roleIds.filter((roleId) =>
      existingRoleIds.includes(roleId)
    );

    if (newRoleIds.length === 0) {
      throw new Error("User already has all the specified roles");
    }

    // Add new roles to user (convert strings to ObjectIds)
    const objectIdRoleIds = [];
    for (const id of newRoleIds) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error(
          `Invalid ObjectId format: ${id}. ObjectId must be a 24-character hex string.`
        );
      }
      objectIdRoleIds.push(new mongoose.Types.ObjectId(id));
    }
    user.roles.push(...objectIdRoleIds);
    await user.save();

    // Get updated user with populated roles
    const updatedUser = await User.findOne({ _id: userId, tenantId }).populate(
      "roles"
    );

    return {
      user: updatedUser,
      assignedRoles: newRoleIds.length,
      alreadyAssignedRoles: alreadyAssignedRoleIds.length,
      assignedRoleIds: newRoleIds,
      alreadyAssignedRoleIds: alreadyAssignedRoleIds,
    };
  } catch (error) {
    if (error instanceof RolePrivilegeError) throw error;
    throw new Error(`Error assigning roles to user: ${error.message}`);
  }
};

/**
 * Sync user roles to match the given list. Adds missing roles and removes roles not in the list.
 * @param {string} userId - User ID
 * @param {string[]} roleIds - Desired role IDs (can be empty to remove all)
 * @param {string} tenantId - Tenant ID
 */
module.exports.syncRolesForUser = async (userId, roleIds, tenantId, actor) => {
  try {
    assertRoleAssignmentAllowed(actor, []); // actor context required (fail closed)
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw new Error(
        `Invalid userId format: ${userId}. ObjectId must be a 24-character hex string.`
      );
    }

    const ids = Array.isArray(roleIds) ? roleIds : [];
    for (const roleId of ids) {
      if (!mongoose.Types.ObjectId.isValid(roleId)) {
        throw new Error(
          `Invalid roleId format: ${roleId}. ObjectId must be a 24-character hex string.`
        );
      }
    }

    const user = await User.findOne({ _id: userId, tenantId });
    if (!user) {
      throw new Error("User not found");
    }

    // Phase 1C-2C: roles the user holds that the new set drops are removals — a non-SU actor may not
    // drop a protected (or unverifiable) role. Protected roles that stay assigned do not block.
    const desired = new Set(ids.map(String));
    const implicitlyRemoved = (user.roles || []).map(String).filter((r) => !desired.has(r));
    await assertImplicitRoleRemovalAllowed(actor, tenantId, implicitlyRemoved);

    if (ids.length === 0) {
      user.roles = [];
      await user.save();
      const updatedUser = await User.findOne({ _id: userId, tenantId }).populate(
        "roles"
      );
      return { user: updatedUser };
    }

    const roles = await Role.find({
      _id: { $in: ids },
      tenantId,
      isActive: true,
    });
    if (roles.length !== ids.length) {
      const foundIds = roles.map((r) => r._id.toString());
      const missing = ids.filter((id) => !foundIds.includes(id));
      throw new Error(`Roles not found: ${missing.join(", ")}`);
    }

    // Phase 1C-2B: validate EVERY requested role (tenant-scoped persisted docs) before touching the user.
    // Phase 1C-2C: only NEWLY added roles are assignments; protected roles the user already holds and
    // keeps are not re-assigned, so they do not block the sync.
    const heldRoleIds = new Set((user.roles || []).map(String));
    assertRoleAssignmentAllowed(actor, roles.filter((r) => !heldRoleIds.has(String(r._id))));

    user.roles = ids.map((id) => new mongoose.Types.ObjectId(id));
    await user.save();

    const updatedUser = await User.findOne({ _id: userId, tenantId }).populate(
      "roles"
    );
    return { user: updatedUser };
  } catch (error) {
    if (error instanceof RolePrivilegeError) throw error;
    throw new Error(`Error syncing roles for user: ${error.message}`);
  }
};

module.exports.removeRolesFromUser = async (userId, roleIds, tenantId, actor) => {
  try {
    const user = await User.findOne({ _id: userId, tenantId });

    if (!user) {
      throw new Error("User not found");
    }

    // Phase 1C-2C: validate EVERY requested role (tenant-scoped, persisted) before touching the user.
    await assertRequestedRoleRemovalAllowed(actor, tenantId, roleIds);

    // Check which roles user actually has
    const existingRoleIds = (user.roles || []).map((roleId) =>
      roleId.toString()
    );
    const rolesToRemove = roleIds.filter((roleId) =>
      existingRoleIds.includes(roleId)
    );
    const notAssignedRoleIds = roleIds.filter(
      (roleId) => !existingRoleIds.includes(roleId)
    );

    if (rolesToRemove.length === 0) {
      throw new Error("User doesn't have any of the specified roles");
    }

    // Remove roles from user
    user.roles = (user.roles || []).filter(
      (roleId) => !roleIds.includes(roleId.toString())
    );
    await user.save();

    // Get updated user with populated roles
    const updatedUser = await User.findOne({ _id: userId, tenantId }).populate(
      "roles"
    );

    return {
      user: updatedUser,
      removedRoles: rolesToRemove.length,
      notAssignedRoles: notAssignedRoleIds.length,
      removedRoleIds: rolesToRemove,
      notAssignedRoleIds: notAssignedRoleIds,
    };
  } catch (error) {
    if (error instanceof RolePrivilegeError) throw error;
    throw new Error(`Error removing roles from user: ${error.message}`);
  }
};

module.exports.removeRoleFromUser = async (userId, roleId, tenantId, actor) => {
  try {
    const user = await User.findOne({ _id: userId, tenantId });
    if (!user) {
      throw new Error("User not found");
    }
    // Phase 1C-2C: validate the (tenant-scoped, persisted) role before touching the user.
    await assertRequestedRoleRemovalAllowed(actor, tenantId, [roleId]);

    user.roles = user.roles.filter((role) => role.toString() !== roleId);
    await user.save();

    return await User.findOne({ _id: userId, tenantId }).populate("roles");
  } catch (error) {
    if (error instanceof RolePrivilegeError) throw error;
    throw new Error(`Error removing role from user: ${error.message}`);
  }
};

module.exports.getUserPermissions = async (userId, tenantId) => {
  try {
    const user = await User.findOne({ _id: userId, tenantId }).populate(
      "roles"
    );
    if (!user) {
      throw new Error("User not found");
    }

    const permissions = new Set();

    // Check if user has Super User role
    const hasSuperUserRole = user.roles.some((role) => role.code === "SU");
    if (hasSuperUserRole) {
      return ["*"]; // Full access
    }

    // Collect permissions from all roles
    for (const role of user.roles) {
      // Handle both ObjectId and string permissions
      const objectIdPermissions = role.permissions.filter(
        (p) => typeof p === "string" && p.match(/^[0-9a-fA-F]{24}$/)
      );
      const stringPermissions = role.permissions.filter(
        (p) => typeof p === "string" && !p.match(/^[0-9a-fA-F]{24}$/)
      );

      // Resolve every permission (whether stored as an ObjectId or a CODE string
      // like "ISSUES_COMPLAINTS_READ") against the Permission collection and emit
      // the canonical `${resource}:${action}` form using its actual resource/action
      // fields. A regex like s/_/:/g on the CODE string can't recover the correct
      // resource/action boundary for multi-word resources or actions (e.g.
      // "ISSUES_COMPLAINTS_READ" -> resource "issues-complaints", action "read", vs
      // "USER_MANAGE_ROLES" -> resource "user", action "manage_roles" - the same
      // regex can't produce both correctly), so downstream consumers (policy
      // checks in every service, jwt.js's token permissions) must receive the
      // resolved form, not a heuristic guess.
      const permissionDocs = [];
      if (objectIdPermissions.length > 0) {
        permissionDocs.push(
          ...(await Permission.find({ _id: { $in: objectIdPermissions } }))
        );
      }
      if (stringPermissions.length > 0) {
        permissionDocs.push(
          ...(await Permission.find({ code: { $in: stringPermissions } }))
        );
      }
      permissionDocs.forEach((perm) => {
        permissions.add(`${perm.resource}:${perm.action}`.toLowerCase());
      });

      // A string permission that doesn't match any known Permission code is
      // assumed to already be a literal `resource:action` string (legacy data
      // predating the CODE convention) - pass it through unchanged.
      const resolvedCodes = new Set(permissionDocs.map((p) => p.code));
      stringPermissions
        .filter((p) => !resolvedCodes.has(p))
        .forEach((perm) => permissions.add(perm.toLowerCase()));
    }

    return Array.from(permissions);
  } catch (error) {
    throw new Error(`Error fetching user permissions: ${error.message}`);
  }
};

module.exports.getUserRoles = async (userId, tenantId) => {
  try {
    const user = await User.findOne({ _id: userId, tenantId }).populate(
      "roles"
    );
    if (!user) {
      throw new Error("User not found");
    }
    return user.roles;
  } catch (error) {
    throw new Error(`Error fetching user roles: ${error.message}`);
  }
};

module.exports.getUsersByRole = async (roleId, tenantId) => {
  try {
    return await User.find({ roles: roleId, tenantId })
      .select("_id userEmail userFirstName userLastName userFullName roles isActive")
      .lean();
  } catch (error) {
    throw new Error(`Error fetching users by role: ${error.message}`);
  }
};

module.exports.getUsersByRoleIds = async (roleIds, tenantId) => {
  try {
    const uniqueRoleIds = [
      ...new Set((Array.isArray(roleIds) ? roleIds : []).filter(Boolean)),
    ];

    uniqueRoleIds.forEach((roleId) => {
      if (!mongoose.Types.ObjectId.isValid(roleId)) {
        throw new Error(
          `Invalid roleId format: ${roleId}. ObjectId must be a 24-character hex string.`
        );
      }
    });

    if (uniqueRoleIds.length === 0) {
      return {};
    }

    const users = await User.find({
      tenantId,
      roles: { $in: uniqueRoleIds },
    })
      .select("_id userEmail userFirstName userLastName userFullName roles isActive")
      .lean();

    return uniqueRoleIds.reduce((acc, roleId) => {
      acc[roleId] = users.filter((user) =>
        (user.roles || []).some((userRoleId) => String(userRoleId) === String(roleId))
      );
      return acc;
    }, {});
  } catch (error) {
    throw new Error(`Error fetching users by roles: ${error.message}`);
  }
};

/**
 * Users who hold a given resource:action permission, via whichever of their tenant's roles
 * grants it - for issue-service's Owner/Resolved By pickers, scoped per issueType to
 * "issues-<team>:write" (see backend/issue-service/services/issue.service.js's
 * TEAM_RESOURCE_BY_ISSUE_TYPE / hasTeamWritePermission for the resource-per-team mapping this
 * feeds). Mirrors getAllRoles' mixed ObjectId/code role.permissions resolution above, just
 * inverted (permission -> roles -> users instead of role -> permissions).
 */
module.exports.getUsersByPermission = async (
  resource,
  action,
  tenantId,
  { q, limit = 20 } = {},
) => {
  try {
    const permission = await Permission.findOne({ resource, action }).lean();
    if (!permission) return [];

    const roles = await Role.find({
      tenantId,
      isActive: true,
      $or: [
        { permissions: String(permission._id) },
        { permissions: permission.code },
      ],
    })
      .select("_id")
      .lean();
    const roleIds = roles.map((role) => role._id);
    if (roleIds.length === 0) return [];

    const query = { tenantId, isActive: true, roles: { $in: roleIds } };
    if (q && q.trim()) {
      const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { userEmail: { $regex: escaped, $options: "i" } },
        { userFirstName: { $regex: escaped, $options: "i" } },
        { userLastName: { $regex: escaped, $options: "i" } },
        { userFullName: { $regex: escaped, $options: "i" } },
      ];
    }

    return await User.find(query)
      .select("_id userEmail userFirstName userLastName userFullName")
      .sort({ userFullName: 1 })
      .limit(Math.min(Number(limit) || 20, 50))
      .lean();
  } catch (error) {
    throw new Error(`Error fetching users by permission: ${error.message}`);
  }
};

module.exports.hasRole = async (userId, roleCode, tenantId) => {
  try {
    const user = await User.findOne({ _id: userId, tenantId }).populate(
      "roles"
    );
    if (!user) {
      return false;
    }

    return user.roles.some((role) => role.code === roleCode);
  } catch (error) {
    throw new Error(`Error checking user role: ${error.message}`);
  }
};

// Additional helper functions to replace constants usage
module.exports.getAllRolesList = async (tenantId = null) => {
  try {
    const filter = { isActive: true };
    if (tenantId) {
      filter.tenantId = tenantId;
    }

    const roles = await Role.find(filter)
      .populate("tenantId", "name code")
      .sort({ category: 1, name: 1 });

    // Transform to match sample roles format
    return roles.map((role) => ({
      id: role.code,
      name: role.name,
      description: role.description,
      tenantId: role.tenantId?._id?.toString(),
      tenantName: role.tenantId?.name,
      category: role.category,
      permissions: role.permissions,
      status: role.isActive ? "active" : "inactive",
      isSystemRole: role.isSystemRole,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    }));
  } catch (error) {
    throw new Error(`Error fetching all roles list: ${error.message}`);
  }
};

module.exports.getRolesByCategory = async (tenantId = null) => {
  try {
    const roles = await this.getAllRolesList(tenantId);

    // Group roles by category
    return roles.reduce((acc, role) => {
      const category = role.category || "OTHER";
      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push(role);
      return acc;
    }, {});
  } catch (error) {
    throw new Error(`Error fetching roles by category: ${error.message}`);
  }
};

module.exports.getTenantsList = async () => {
  try {
    const tenants = await Tenant.find({ isActive: true })
      .select("_id name code description status")
      .sort({ name: 1 });

    return tenants.map((tenant) => ({
      id: tenant._id.toString(),
      name: tenant.name,
      code: tenant.code,
      description: tenant.description,
      status: tenant.status,
    }));
  } catch (error) {
    throw new Error(`Error fetching tenants list: ${error.message}`);
  }
};
