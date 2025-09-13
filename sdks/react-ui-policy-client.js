/**
 * Enhanced React Policy Client for Proactive UI Authorization
 *
 * This client extends the basic policy client with UI-specific features:
 * - Batch permission initialization
 * - UI capability mapping
 * - Navigation building
 * - Feature flag generation
 */

import PolicyClient from "./react-policy-client";

class UIAwarePolicyClient extends PolicyClient {
  constructor(baseUrl, options = {}) {
    super(baseUrl, options);
    this.uiConfig = options.uiConfig || this.getDefaultUIConfig();
  }

  /**
   * Default UI configuration defining all possible UI actions
   */
  getDefaultUIConfig() {
    return {
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
          {
            resource: "user",
            action: "delete",
            label: "Delete Users",
            icon: "🗑️",
          },
        ],
        roles: [
          { resource: "role", action: "read", label: "View Roles", icon: "👀" },
          {
            resource: "role",
            action: "write",
            label: "Create/Edit Roles",
            icon: "✏️",
          },
          {
            resource: "role",
            action: "delete",
            label: "Delete Roles",
            icon: "🗑️",
          },
        ],
        data: [
          {
            resource: "crm",
            action: "write",
            label: "Create Records",
            icon: "➕",
          },
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
  }

  /**
   * Initialize complete UI permissions and capabilities
   * @param {string} token - JWT token
   * @returns {Promise<Object>} Complete UI authorization state
   */
  async initializeUI(token) {
    try {
      console.log("🔄 Initializing UI permissions...");

      // Collect all unique permission checks needed
      const allChecks = this.collectAllPermissionChecks();

      // Batch evaluate all permissions
      const requests = allChecks.map((check) => ({
        token,
        resource: check.resource,
        action: check.action,
        context: check.context || {},
      }));

      const results = await this.evaluateBatch(requests);

      // Build permission map
      const permissions = {};
      results.forEach((result, index) => {
        const check = allChecks[index];
        const key = `${check.resource}_${check.action}`;
        permissions[key] = result.success;
      });

      // Build UI capabilities
      const capabilities = this.buildUICapabilities(permissions);

      // Get detailed resource permissions
      const resourcePermissions = await this.getResourcePermissions(token);

      const uiState = {
        permissions,
        capabilities,
        resourcePermissions,
        initialized: true,
        timestamp: new Date().toISOString(),
      };

      console.log("✅ UI permissions initialized:", capabilities);
      return uiState;
    } catch (error) {
      console.error("❌ Failed to initialize UI permissions:", error);
      throw error;
    }
  }

  /**
   * Collect all unique permission checks from UI config
   */
  collectAllPermissionChecks() {
    const checks = new Set();

    // Navigation permissions
    this.uiConfig.navigation.forEach((nav) => {
      checks.add(
        JSON.stringify({
          resource: nav.resource,
          action: nav.action,
          context: { type: "navigation" },
        })
      );
    });

    // Action permissions
    Object.values(this.uiConfig.actions)
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
    this.uiConfig.features.forEach((feature) => {
      checks.add(
        JSON.stringify({
          resource: feature.resource,
          action: feature.action,
          context: { type: "feature" },
        })
      );
    });

    // Page permissions
    this.uiConfig.pages.forEach((page) => {
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
  buildUICapabilities(permissions) {
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
    this.uiConfig.navigation.forEach((nav) => {
      if (permissions[`${nav.resource}_${nav.action}`]) {
        capabilities.navigation.push({
          ...nav,
          permitted: true,
        });
      }
    });

    // Build actions by category
    Object.entries(this.uiConfig.actions).forEach(([category, actions]) => {
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
    this.uiConfig.features.forEach((feature) => {
      const permitted = permissions[`${feature.resource}_${feature.action}`];
      capabilities.features[feature.key] = {
        ...feature,
        permitted,
      };
    });

    // Build accessible pages
    this.uiConfig.pages.forEach((page) => {
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
   * Get detailed permissions for all resources
   */
  async getResourcePermissions(token) {
    const resources = ["portal", "crm", "admin", "user", "role"];
    const resourcePermissions = {};

    await Promise.all(
      resources.map(async (resource) => {
        try {
          const result = await this.getPermissions(token, resource);
          if (result.success) {
            resourcePermissions[resource] = result.permissions;
          }
        } catch (error) {
          console.warn(`Failed to get permissions for ${resource}:`, error);
          resourcePermissions[resource] = [];
        }
      })
    );

    return resourcePermissions;
  }

  /**
   * Generate navigation menu data
   * @param {Object} capabilities - UI capabilities from initializeUI
   * @returns {Array} Navigation menu items
   */
  generateNavigationMenu(capabilities) {
    return capabilities.navigation.map((nav) => ({
      id: nav.resource,
      label: nav.label,
      path: nav.path,
      icon: nav.icon,
      active: window.location.pathname.startsWith(nav.path),
    }));
  }

  /**
   * Generate action buttons for a category
   * @param {Object} capabilities - UI capabilities
   * @param {string} category - Action category
   * @returns {Array} Action button configurations
   */
  generateActionButtons(capabilities, category) {
    const actions = capabilities.actions[category] || [];
    return actions.map((action) => ({
      id: `${action.resource}_${action.action}`,
      label: action.label,
      icon: action.icon,
      resource: action.resource,
      action: action.action,
      onClick: () => this.handleAction(action),
    }));
  }

  /**
   * Check if user can access a specific page
   * @param {Object} capabilities - UI capabilities
   * @param {string} path - Page path
   * @returns {boolean} Whether user can access the page
   */
  canAccessPage(capabilities, path) {
    return capabilities.pages.some(
      (page) => page.path === path && page.permitted
    );
  }

  /**
   * Get feature flags as a simple object
   * @param {Object} capabilities - UI capabilities
   * @returns {Object} Feature flags
   */
  getFeatureFlags(capabilities) {
    const flags = {};
    Object.entries(capabilities.features).forEach(([key, feature]) => {
      flags[key] = feature.permitted;
    });
    return flags;
  }

  /**
   * Generate dashboard widgets based on permissions
   * @param {Object} capabilities - UI capabilities
   * @returns {Array} Dashboard widget configurations
   */
  generateDashboardWidgets(capabilities) {
    const widgets = [];

    // Add navigation widgets
    capabilities.navigation.forEach((nav) => {
      widgets.push({
        type: "navigation",
        id: nav.resource,
        title: nav.label,
        icon: nav.icon,
        path: nav.path,
        priority: this.getWidgetPriority(nav.resource),
      });
    });

    // Add quick action widgets
    Object.entries(capabilities.actions).forEach(([category, actions]) => {
      if (actions.length > 0) {
        widgets.push({
          type: "actions",
          id: category,
          title: this.getCategoryTitle(category),
          actions: actions.slice(0, 3), // Limit to 3 actions per widget
          priority: this.getWidgetPriority(category),
        });
      }
    });

    // Sort by priority
    return widgets.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get widget priority for dashboard ordering
   */
  getWidgetPriority(resource) {
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
  }

  /**
   * Get human-readable category title
   */
  getCategoryTitle(category) {
    const titles = {
      users: "User Management",
      roles: "Role Management",
      data: "Data Operations",
      system: "System Administration",
    };
    return (
      titles[category] || category.charAt(0).toUpperCase() + category.slice(1)
    );
  }

  /**
   * Handle action button clicks
   */
  handleAction(action) {
    // Emit custom event or call callback
    const event = new CustomEvent("policyAction", {
      detail: {
        resource: action.resource,
        action: action.action,
        label: action.label,
      },
    });
    window.dispatchEvent(event);
  }

  /**
   * React Hook for UI initialization
   */
  useUIInitialization(token) {
    const [uiState, setUIState] = React.useState({
      loading: true,
      capabilities: null,
      permissions: {},
      error: null,
    });

    React.useEffect(() => {
      if (!token) {
        setUIState({
          loading: false,
          capabilities: null,
          permissions: {},
          error: "No token provided",
        });
        return;
      }

      this.initializeUI(token)
        .then((result) => {
          setUIState({
            loading: false,
            capabilities: result.capabilities,
            permissions: result.permissions,
            resourcePermissions: result.resourcePermissions,
            error: null,
          });
        })
        .catch((error) => {
          setUIState({
            loading: false,
            capabilities: null,
            permissions: {},
            error: error.message,
          });
        });
    }, [token]);

    return uiState;
  }
}

export default UIAwarePolicyClient;
