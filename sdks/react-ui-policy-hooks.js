/**
 * React UI Policy Hooks for Proactive UI Authorization
 *
 * These hooks provide UI-specific functionality for building permission-aware interfaces
 *
 * Usage:
 * import { useUIInitialization, useNavigationMenu, useActionButtons } from './react-ui-policy-hooks';
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { usePolicyClient, useMultiplePermissions } from "./react-policy-hooks";

/**
 * Default UI configuration defining all possible UI actions
 */
const DEFAULT_UI_CONFIG = {
  navigation: [
    {
      resource: "portal",
      action: "read",
      label: "Portal",
      path: "/portal",
      icon: "🏠",
    },
    {
      resource: "crm",
      action: "read",
      label: "CRM",
      path: "/crm",
      icon: "👥",
    },
    {
      resource: "admin",
      action: "read",
      label: "Admin",
      path: "/admin",
      icon: "⚙️",
    },
  ],

  actions: {
    users: [
      { resource: "user", action: "read", label: "View Users", icon: "👀" },
      {
        resource: "user",
        action: "write",
        label: "Create/Edit Users",
        icon: "✏️",
      },
      { resource: "user", action: "delete", label: "Delete Users", icon: "🗑️" },
    ],
    roles: [
      { resource: "role", action: "read", label: "View Roles", icon: "👀" },
      {
        resource: "role",
        action: "write",
        label: "Create/Edit Roles",
        icon: "✏️",
      },
      { resource: "role", action: "delete", label: "Delete Roles", icon: "🗑️" },
    ],
    data: [
      { resource: "crm", action: "write", label: "Create Records", icon: "➕" },
      {
        resource: "crm",
        action: "delete",
        label: "Delete Records",
        icon: "🗑️",
      },
    ],
    system: [
      {
        resource: "admin",
        action: "write",
        label: "System Config",
        icon: "🔧",
      },
      {
        resource: "admin",
        action: "delete",
        label: "System Maintenance",
        icon: "🛠️",
      },
    ],
  },

  features: [
    {
      key: "user_management",
      resource: "user",
      action: "read",
      label: "User Management",
    },
    {
      key: "role_management",
      resource: "role",
      action: "read",
      label: "Role Management",
    },
    {
      key: "advanced_admin",
      resource: "admin",
      action: "write",
      label: "Advanced Administration",
    },
    {
      key: "data_deletion",
      resource: "crm",
      action: "delete",
      label: "Data Deletion",
    },
  ],

  pages: [
    {
      path: "/users",
      requiredPermissions: [{ resource: "user", action: "read" }],
      label: "User Management",
      component: "UserManagementPage",
    },
    {
      path: "/roles",
      requiredPermissions: [{ resource: "role", action: "read" }],
      label: "Role Management",
      component: "RoleManagementPage",
    },
    {
      path: "/admin",
      requiredPermissions: [{ resource: "admin", action: "read" }],
      label: "Administration",
      component: "AdminPage",
    },
  ],
};

/**
 * Collect all unique permission checks from UI config
 */
function collectAllPermissionChecks(uiConfig) {
  const checks = new Set();

  // Navigation permissions
  uiConfig.navigation.forEach((nav) => {
    checks.add(
      JSON.stringify({
        resource: nav.resource,
        action: nav.action,
        context: { type: "navigation" },
      })
    );
  });

  // Action permissions
  Object.values(uiConfig.actions)
    .flat()
    .forEach((action) => {
      checks.add(
        JSON.stringify({
          resource: action.resource,
          action: action.action,
          context: { type: "action" },
        })
      );
    });

  // Feature permissions
  uiConfig.features.forEach((feature) => {
    checks.add(
      JSON.stringify({
        resource: feature.resource,
        action: feature.action,
        context: { type: "feature" },
      })
    );
  });

  // Page permissions
  uiConfig.pages.forEach((page) => {
    page.requiredPermissions.forEach((perm) => {
      checks.add(
        JSON.stringify({
          resource: perm.resource,
          action: perm.action,
          context: { type: "page", path: page.path },
        })
      );
    });
  });

  return Array.from(checks).map((check) => JSON.parse(check));
}

/**
 * Build UI capabilities from permissions
 */
function buildUICapabilities(permissions, uiConfig) {
  const capabilities = {
    navigation: [],
    actions: {},
    features: {},
    pages: [],
    stats: {
      totalPermissions: Object.keys(permissions).length,
      grantedPermissions: Object.values(permissions).filter((p) => p).length,
    },
  };

  // Build navigation
  uiConfig.navigation.forEach((nav) => {
    if (permissions[`${nav.resource}_${nav.action}`]) {
      capabilities.navigation.push({
        ...nav,
        permitted: true,
      });
    }
  });

  // Build actions by category
  Object.entries(uiConfig.actions).forEach(([category, actions]) => {
    const permittedActions = actions.filter(
      (action) => permissions[`${action.resource}_${action.action}`]
    );

    if (permittedActions.length > 0) {
      capabilities.actions[category] = permittedActions.map((action) => ({
        ...action,
        permitted: true,
      }));
    }
  });

  // Build features
  uiConfig.features.forEach((feature) => {
    const permitted = permissions[`${feature.resource}_${feature.action}`];
    capabilities.features[feature.key] = {
      ...feature,
      permitted,
    };
  });

  // Build accessible pages
  uiConfig.pages.forEach((page) => {
    const hasAllPermissions = page.requiredPermissions.every(
      (perm) => permissions[`${perm.resource}_${perm.action}`]
    );

    if (hasAllPermissions) {
      capabilities.pages.push({
        ...page,
        permitted: true,
      });
    }
  });

  return capabilities;
}

/**
 * Hook for complete UI initialization
 */
export function useUIInitialization(
  PolicyClientClass,
  baseUrl,
  token,
  options = {}
) {
  const { uiConfig = DEFAULT_UI_CONFIG, ...clientOptions } = options;
  const policyClient = usePolicyClient(
    PolicyClientClass,
    baseUrl,
    clientOptions
  );

  // Collect all permission checks needed
  const permissionChecks = useMemo(
    () => collectAllPermissionChecks(uiConfig),
    [uiConfig]
  );

  // Get all permissions
  const {
    loading: permissionsLoading,
    permissions,
    allLoaded,
    error,
  } = useMultiplePermissions(policyClient, token, permissionChecks);

  // Build capabilities from permissions
  const capabilities = useMemo(() => {
    if (!allLoaded) return null;
    return buildUICapabilities(permissions, uiConfig);
  }, [permissions, allLoaded, uiConfig]);

  // Get detailed resource permissions
  const [resourcePermissions, setResourcePermissions] = useState({});
  const [resourceLoading, setResourceLoading] = useState(false);

  useEffect(() => {
    if (!token || !policyClient || !allLoaded) return;

    const fetchResourcePermissions = async () => {
      setResourceLoading(true);
      const resources = ["portal", "crm", "admin", "user", "role"];
      const results = {};

      await Promise.all(
        resources.map(async (resource) => {
          try {
            const result = await policyClient.getPermissions(token, resource);
            if (result.success) {
              results[resource] = result.permissions;
            }
          } catch (error) {
            console.warn(`Failed to get permissions for ${resource}:`, error);
            results[resource] = [];
          }
        })
      );

      setResourcePermissions(results);
      setResourceLoading(false);
    };

    fetchResourcePermissions();
  }, [policyClient, token, allLoaded]);

  const uiState = useMemo(() => {
    if (permissionsLoading || resourceLoading || !capabilities) {
      return {
        loading: true,
        capabilities: null,
        permissions: {},
        resourcePermissions: {},
        error: null,
        initialized: false,
      };
    }

    return {
      loading: false,
      capabilities,
      permissions,
      resourcePermissions,
      error,
      initialized: true,
      timestamp: new Date().toISOString(),
    };
  }, [
    permissionsLoading,
    resourceLoading,
    capabilities,
    permissions,
    resourcePermissions,
    error,
  ]);

  return uiState;
}

/**
 * Hook for navigation menu generation
 */
export function useNavigationMenu(capabilities) {
  return useMemo(() => {
    if (!capabilities?.navigation) return [];

    return capabilities.navigation.map((nav) => ({
      id: nav.resource,
      label: nav.label,
      path: nav.path,
      icon: nav.icon,
      active:
        typeof window !== "undefined" && window.location
          ? window.location.pathname.startsWith(nav.path)
          : false,
    }));
  }, [capabilities]);
}

/**
 * Hook for action buttons generation
 */
export function useActionButtons(capabilities, category) {
  const handleAction = useCallback((action) => {
    const event = new CustomEvent("policyAction", {
      detail: {
        resource: action.resource,
        action: action.action,
        label: action.label,
      },
    });

    if (typeof window !== "undefined" && window.dispatchEvent) {
      window.dispatchEvent(event);
    } else {
      // React Native fallback - could emit to EventEmitter or custom event system
      console.log("Policy action triggered:", event.detail);
    }
  }, []);

  return useMemo(() => {
    const actions = capabilities?.actions?.[category] || [];
    return actions.map((action) => ({
      id: `${action.resource}_${action.action}`,
      label: action.label,
      icon: action.icon,
      resource: action.resource,
      action: action.action,
      onClick: () => handleAction(action),
    }));
  }, [capabilities, category, handleAction]);
}

/**
 * Hook for page access checking
 */
export function usePageAccess(capabilities, path) {
  return useMemo(() => {
    if (!capabilities?.pages) return false;
    return capabilities.pages.some(
      (page) => page.path === path && page.permitted
    );
  }, [capabilities, path]);
}

/**
 * Hook for feature flags
 */
export function useFeatureFlags(capabilities) {
  return useMemo(() => {
    if (!capabilities?.features) return {};

    const flags = {};
    Object.entries(capabilities.features).forEach(([key, feature]) => {
      flags[key] = feature.permitted;
    });
    return flags;
  }, [capabilities]);
}

/**
 * Hook for dashboard widgets generation
 */
export function useDashboardWidgets(capabilities) {
  const getWidgetPriority = useCallback((resource) => {
    const priorities = {
      portal: 100,
      crm: 90,
      users: 80,
      roles: 70,
      admin: 60,
      data: 50,
      system: 40,
    };
    return priorities[resource] || 30;
  }, []);

  const getCategoryTitle = useCallback((category) => {
    const titles = {
      users: "User Management",
      roles: "Role Management",
      data: "Data Operations",
      system: "System Administration",
    };
    return (
      titles[category] || category.charAt(0).toUpperCase() + category.slice(1)
    );
  }, []);

  return useMemo(() => {
    if (!capabilities) return [];

    const widgets = [];

    // Add navigation widgets
    capabilities.navigation?.forEach((nav) => {
      widgets.push({
        type: "navigation",
        id: nav.resource,
        title: nav.label,
        icon: nav.icon,
        path: nav.path,
        priority: getWidgetPriority(nav.resource),
      });
    });

    // Add quick action widgets
    Object.entries(capabilities.actions || {}).forEach(
      ([category, actions]) => {
        if (actions.length > 0) {
          widgets.push({
            type: "actions",
            id: category,
            title: getCategoryTitle(category),
            actions: actions.slice(0, 3), // Limit to 3 actions per widget
            priority: getWidgetPriority(category),
          });
        }
      }
    );

    // Sort by priority
    return widgets.sort((a, b) => b.priority - a.priority);
  }, [capabilities, getWidgetPriority, getCategoryTitle]);
}

/**
 * Hook for conditional component rendering
 */
export function useConditionalRender(capabilities, resource, action) {
  const isAuthorized = useMemo(() => {
    if (!capabilities?.permissions) return false;
    return capabilities.permissions[`${resource}_${action}`] === true;
  }, [capabilities, resource, action]);

  const ConditionalComponent = useCallback(
    ({ children, fallback = null }) => {
      return isAuthorized ? children : fallback;
    },
    [isAuthorized]
  );

  return { isAuthorized, ConditionalComponent };
}

/**
 * Hook for permission-based component rendering
 */
export function usePermissionRender(capabilities, resource, permission) {
  const hasPermission = useMemo(() => {
    if (!capabilities?.resourcePermissions?.[resource]) return false;
    const permissions = capabilities.resourcePermissions[resource];
    return permissions.includes(permission) || permissions.includes("*");
  }, [capabilities, resource, permission]);

  const PermissionComponent = useCallback(
    ({ children, fallback = null }) => {
      return hasPermission ? children : fallback;
    },
    [hasPermission]
  );

  return { hasPermission, PermissionComponent };
}
